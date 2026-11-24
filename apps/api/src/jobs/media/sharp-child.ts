// It imports only sharp and node:*, and uses only syntax Node can run by stripping the types, so the same file runs
// from source and, compiled, from dist.
import { join } from "node:path";
import sharp from "sharp";

// Decoding is bounded by pixels, not bytes: a few dozen bytes can declare billions of pixels. 8K is 33 MP; a 100 MP PNG
// decodes to about 400 MB. The pixel limit is also what bounds libvips' memory, which the parent's heap flag does not.
const MAX_PIXELS = 50_000_000;
const THUMB_WIDTH = 320;
// The copy a provider receives is re-encoded, so it is kept closer to the original than sharp's default of 80; PNG and
// GIF stay lossless.
const STRIPPED_QUALITY = 90;
const EXTENSIONS: Record<string, string> = { jpeg: "jpg", png: "png", gif: "gif", webp: "webp" };
const MIMES: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

// Only the reason leaves this process: sharp's own text can carry paths, and nothing of the image is printed.
const reasonOf = (error: unknown): string =>
  error instanceof Error && error.message.includes("exceeds pixel limit") ? "pixel_limit" : "corrupt";

async function run(inputPath: string, outputDir: string) {
  sharp.cache(false);
  sharp.concurrency(1);
  // Opened as an animation, sharp counts the pixels of every frame against the limit (probed on 0.35.5), so a long
  // animation of small frames is refused like one huge image.
  const open = (animated: boolean) => sharp(inputPath, { limitInputPixels: MAX_PIXELS, animated });
  const format = (await open(true).metadata()).format ?? "";
  if (!Object.hasOwn(EXTENSIONS, format)) return { ok: false, reason: "unsupported_type" };
  // sharp writes no metadata (EXIF, GPS, XMP, IPTC, ICC) unless asked, so the outputs carry none.
  const strippedPath = join(outputDir, `stripped.${EXTENSIONS[format]}`);
  const stripped = await open(format === "gif" || format === "webp")
    .rotate()
    .toFormat(format as "jpeg", format === "jpeg" || format === "webp" ? { quality: STRIPPED_QUALITY } : {})
    .toFile(strippedPath);
  const thumbPath = join(outputDir, "thumb.webp");
  await open(false)
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp()
    .toFile(thumbPath);
  return {
    ok: true,
    width: stripped.width,
    // The height of one frame: an animation is read as one tall image of its frames.
    height: stripped.pageHeight ?? stripped.height,
    mime: MIMES[format],
  };
}

const [inputPath = "", outputDir = ""] = process.argv.slice(2);
const answer = await run(inputPath, outputDir).catch((error: unknown) => ({
  ok: false,
  reason: reasonOf(error),
}));
process.stdout.write(JSON.stringify(answer));
