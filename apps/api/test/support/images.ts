import sharp from "sharp";

export async function jpeg(
  options: { gps?: boolean; width?: number; height?: number } = {},
): Promise<Buffer> {
  const image = sharp({
    create: { width: options.width ?? 64, height: options.height ?? 48, channels: 3, background: "#336699" },
  });
  if (options.gps)
    image.withExif({
      IFD0: { Copyright: "exif-canary-1" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "41/1 24/1 12/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "2/1 10/1 26/1",
      },
    });
  return image.jpeg().toBuffer();
}

export const png = (width = 8, height = 8): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: "#cc3333" } })
    .png()
    .toBuffer();

/** A GIF of `frames` frames, each `width` x `height`: an animation, which a decoder that reads one page flattens. */
export async function animatedGif(frames = 3, width = 40, height = 30): Promise<Buffer> {
  const colours = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"];
  const pages = await Promise.all(
    Array.from({ length: frames }, (_, i) =>
      sharp({ create: { width, height, channels: 3, background: colours[i % colours.length] as string } })
        .png()
        .toBuffer(),
    ),
  );
  return sharp(pages, { join: { animated: true } })
    .gif()
    .toBuffer();
}

const crc = (bytes: Buffer): number => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    let c = (value ^ byte) & 0xff;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    value = (value >>> 8) ^ c;
  }
  return (value ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
};

/** A PNG of a few dozen bytes whose header declares `width` x `height`: a decompression bomb for the pixel limit. */
export function declaredPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const data = Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", data),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function exifTags(exif: Buffer): { ifd0: number[]; gps: number[] | null } {
  const body = exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? exif.subarray(6) : exif;
  const little = body.toString("latin1", 0, 2) === "II";
  const u16 = (at: number) => (little ? body.readUInt16LE(at) : body.readUInt16BE(at));
  const u32 = (at: number) => (little ? body.readUInt32LE(at) : body.readUInt32BE(at));
  const entries = (at: number) =>
    Array.from({ length: u16(at) }, (_, i) => ({
      tag: u16(at + 2 + i * 12),
      value: u32(at + 2 + i * 12 + 8),
    }));
  const zero = entries(u32(4));
  const pointer = zero.find((entry) => entry.tag === 0x8825);
  return {
    ifd0: zero.map((entry) => entry.tag),
    gps: pointer ? entries(pointer.value).map((entry) => entry.tag) : null,
  };
}

export const hasExifSegment = (bytes: Buffer): boolean =>
  bytes.includes(Buffer.from("Exif\0\0", "latin1")) || bytes.includes(Buffer.from("EXIF", "latin1"));
