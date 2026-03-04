import process from "node:process";
import { Bot } from "grammy";
import z from "zod";
import { MessageEntity } from "grammy/types";

const Reply = z.object({
  tweet: z.object({
    text: z.string(),
    author: z.object({
      name: z.string(),
      screen_name: z.string(),
    }),
    media: z.object({
      photos: z
        .object({
          url: z.string(),
        })
        .array(),
    }),
  }),
});

const bot = new Bot(process.env.TOKEN ?? "");

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Send me link to x.com and I reply with gallery of images from it",
  );
});

bot.hears(/(?:https:\/\/)?x\.com\/[^\s]+\/status\/\d+/, async (ctx) => {
  try {
    const url = ctx.match[0].replace("x.com", "api.fxtwitter.com");
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

    if (reply.tweet.media.photos.length > 0) {
      await ctx.replyWithMediaGroup(
        reply.tweet.media.photos.map((photo, i) => ({
          type: "photo",
          media: photo.url,
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
