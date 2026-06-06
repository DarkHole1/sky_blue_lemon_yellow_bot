import process from "node:process";
import { Bot } from "grammy";
import z from "zod";
import { InputFile, MessageEntity } from "grammy/types";
import { SocksProxyAgent } from "socks-proxy-agent";
import fetch from "node-fetch";

const Reply = z.object({
  tweet: z.object({
    text: z.string(),
    author: z.object({
      name: z.string(),
      screen_name: z.string(),
    }),
    media: z.object({
      all: z
        .object({
          type: z.string(),
          url: z.string(),
        })
        .array(),
    }),
  }),
});

let fetchFile = async function* (url: string | URL): AsyncIterable<Uint8Array> {
  const { body } = await fetch(url);
  for await (const chunk of body!) {
    if (typeof chunk === "string") {
      throw new Error(
        `Could not transfer file, received string data instead of bytes from '${url}'`,
      );
    }
    yield chunk;
  }
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

  fetchFile = async function* (url: string | URL): AsyncIterable<Uint8Array> {
    const { body } = await fetch(url, {
      agent: new SocksProxyAgent(proxy_url),
      compress: true,
    });
    for await (const chunk of body!) {
      if (typeof chunk === "string") {
        throw new Error(
          `Could not transfer file, received string data instead of bytes from '${url}'`,
        );
      }
      yield chunk;
    }
  };
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Send me link to x.com and I reply with gallery of images from it",
  );
});

bot.hears(/(?:https:\/\/)?x\.com\/[^\s]+\/status\/\d+/, async (ctx) => {
  try {
    const url = ctx.match[0].replace("x.com", "api.fxtwitter.com");
    const previewUrl = ctx.match[0].replace("x.com", "fixupx.com");
    const res = await fetch(url);
    const data = await res.json();
    const reply = Reply.parse(data);
    const text = `${reply.tweet.text}\n\n🔗 ${reply.tweet.author.name} (@${reply.tweet.author.screen_name})`;
    const startOffset = text.indexOf("🔗");
    const entities: MessageEntity[] = [
      {
        type: "text_link",
        offset: startOffset,
        length: text.length - startOffset,
        url: ctx.match[0],
      },
    ];

    const all = reply.tweet.media.all ?? [];
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
      await ctx.replyWithMediaGroup(
        almostAll.map((media, i) => ({
          type: media.type == "photo" ? "photo" : "video",
          media: new InputFile(fetchFile(media.url)),
          ...(i == 0 ? { caption: text, caption_entities: entities } : {}),
        })),
      );
    } else {
      await ctx.reply(text, {
        entities,
      });
    }
  } catch (e) {
    console.log(e);
    await ctx.reply(
      "Something went wrong. Write @darkhole1 for info with link.",
    );
  }
});

bot.start();
