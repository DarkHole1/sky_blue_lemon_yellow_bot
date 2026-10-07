import process from "node:process";
import { Bot } from "grammy";
import z from "zod";
import {
  InputFile,
  MessageEntity,
  RichText,
  InputRichBlock,
} from "grammy/types";
import { SocksProxyAgent } from "socks-proxy-agent";
import fetch, { Response } from "node-fetch";

const Tweet = z.object({
  url: z.string(),
  text: z.string(),
  author: z.object({
    name: z.string(),
    screen_name: z.string(),
  }),
  media: z
    .object({
      all: z
        .object({
          type: z.string(),
          url: z.string(),
        })
        .array(),
    })
    .optional(),
  get quote() {
    return Tweet.optional();
  },
});
type Tweet = z.infer<typeof Tweet>;

const Reply = z.object({
  tweet: Tweet,
});

const streamBody = async function* (
  body: NodeJS.ReadableStream,
  url: string | URL,
) {
  for await (const chunk of body) {
    if (typeof chunk === "string") {
      throw new Error(
        `Could not transfer file, received string data instead of bytes from '${url}'`,
      );
    }
    yield chunk;
  }
};

let fetchProxy = async function (url: string | URL): Promise<Response> {
  return fetch(url);
};

let bot: Bot = new Bot(process.env.TOKEN ?? "");
if (process.env.HTTP_PROXY) {
  const proxy_url = process.env.HTTP_PROXY;
  bot = new Bot(process.env.TOKEN ?? "", {
    client: {
      baseFetchConfig: {
        agent: new SocksProxyAgent(proxy_url),
        compress: true,
      },
    },
  });

  fetchProxy = async function (url: string | URL): Promise<Response> {
    return fetch(url, {
      agent: new SocksProxyAgent(proxy_url),
      compress: true,
    });
  };
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Send me link to x.com and I reply with gallery of images from it",
  );
});

type Formatted = {
  text: string;
  entities: MessageEntity[];
};

const richToFormatted = (
  text: RichText,
  offset: number = 0,
): [Formatted, number] => {
  if (typeof text == "string") {
    return [{ text, entities: [] }, text.length];
  }
  if (Array.isArray(text)) {
    let currentLength = 0;
    let currentText = "";
    let entities: MessageEntity[] = [];
    for (const textPart of text) {
      const [formatted, length] = richToFormatted(
        textPart,
        offset + currentLength,
      );
      currentText += formatted.text;
      entities = entities.concat(formatted.entities);
      currentLength += length;
    }
    return [{ text: currentText, entities }, currentLength];
  }
  if (text.type == "url") {
    const [formatted, length] = richToFormatted(text.text, offset);
    return [
      {
        text: formatted.text,
        entities: formatted.entities.concat([
          {
            type: "text_link",
            url: text.url,
            offset: offset,
            length: length,
          },
        ]),
      },
      length,
    ];
  }
  throw Error("Not implemented");
};

const formatTweet = (tweet: Tweet): [Formatted, InputRichBlock[]] => {
  const richText: RichText = [
    tweet.text,
    "\n\n",
    {
      type: "url",
      url: tweet.url,
      text: `🔗 ${tweet.author.name} (@${tweet.author.screen_name})`,
    },
  ];

  return [
    richToFormatted(richText)[0],
    [
      {
        type: "paragraph",
        text: richText,
      },
    ],
  ];
};

bot.hears(/(?:https:\/\/)?x\.com\/[^\s]+\/status\/\d+/, async (ctx) => {
  try {
    const url = ctx.match[0].replace("x.com", "api.fxtwitter.com");
    const previewUrl = ctx.match[0].replace("x.com", "fixupx.com");
    const res = await fetch(url);
    const data = await res.json();
    const reply = Reply.parse(data);
    let [formatted, riched] = formatTweet(reply.tweet);
    if (reply.tweet.quote) {
      const [formattedQuote, richedQuote] = formatTweet(reply.tweet.quote);
      const text = `${formatted.text}\n\n${formattedQuote.text}`;
      formatted = {
        text,
        entities: formatted.entities
          .concat([
            {
              type: "blockquote",
              offset: formatted.text.length + 2,
              length: text.length - formatted.text.length - 2,
            },
          ])
          .concat(
            formattedQuote.entities.map((e) =>
              Object.assign({}, e, {
                offset: e.offset + formatted.text.length + 2,
              }),
            ),
          ),
      };
      riched = riched.concat({
        type: "blockquote",
        blocks: richedQuote,
      });
    }

    const all = reply.tweet.media?.all ?? [];
    const almostAll = all.filter((m) =>
      ["photo", "video", "gif"].includes(m.type),
    );

    if (almostAll.some((m) => m.type == "gif") && almostAll.length > 1) {
      await ctx.reply("Gifs albums aren't supported");
      return;
    }

    if (almostAll && almostAll.length > 0) {
      await ctx.replyWithChatAction(
        almostAll[0]?.type == "photo" ? "upload_photo" : "upload_video",
      );
      const fetchedMedia: {
        type: "photo" | "video";
        body: NodeJS.ReadableStream;
        url: string;
      }[] = [];
      for (const media of almostAll) {
        const res = await fetchProxy(media.url);
        const type = media.type == "photo" ? "photo" : "video";
        const maxSize =
          media.type == "photo" ? 9 * 1024 * 1024 : 45 * 1024 * 1024;
        if (Number(res.headers.get("Content-Length") ?? 0) > maxSize) {
          await ctx.reply("One of files is too big for sending, sorry");
          return;
        }
        fetchedMedia.push({
          type,
          body: res.body!,
          url: media.url,
        });
      }
      if (formatted.text.length > 1024) {
        const collage: InputRichBlock[] = fetchedMedia.map(
          (media): InputRichBlock =>
            media.type == "photo"
              ? {
                  type: "photo",
                  photo: {
                    type: "photo",
                    media: new InputFile(streamBody(media.body, media.url)),
                  },
                }
              : {
                  type: "video",
                  video: {
                    type: "video",
                    media: new InputFile(streamBody(media.body, media.url)),
                  },
                },
        );
        await ctx.replyWithRichMessage({
          blocks: riched.concat([
            {
              type: "collage",
              blocks: collage,
            },
          ]),
        });
      } else {
        await ctx.replyWithMediaGroup(
          fetchedMedia.map((media, i) => ({
            type: media.type,
            media: new InputFile(streamBody(media.body, media.url)),
            ...(i == 0
              ? {
                  caption: formatted.text,
                  caption_entities: formatted.entities,
                }
              : {}),
          })),
        );
      }
    } else {
      if (formatted.text.length > 4096) {
        await ctx.replyWithRichMessage({
          blocks: riched,
        });
      } else {
        await ctx.reply(formatted.text, {
          entities: formatted.entities,
        });
      }
    }
  } catch (e) {
    console.log(e);
    await ctx.reply(
      "Something went wrong. Write to @darkhole1 for info with link.",
    );
  }
});

bot.start();
