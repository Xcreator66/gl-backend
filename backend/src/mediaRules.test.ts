import test from "node:test";
import assert from "node:assert/strict";
import { detectMediaType, stripImageMetadata, validVideoProbe, MAX_VIDEO_DURATION_MS } from "./mediaRules.ts";

test("media signature detection rejects client MIME spoofing", () => {
  assert.equal(detectMediaType(Buffer.from([0xff,0xd8,0xff,0x00])), "image/jpeg");
  assert.equal(detectMediaType(Buffer.from("not an image")), null);
});

test("PNG metadata chunks are removed while image data and IEND remain", () => {
  const chunk=(name:string,data:Buffer)=>{const out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length,0);out.write(name,4,"ascii");data.copy(out,8);return out;};
  const head=Buffer.from([137,80,78,71,13,10,26,10]);
  const image=chunk("IDAT",Buffer.from([1,2,3]));
  const exif=chunk("eXIf",Buffer.from("GPSLocation"));
  const end=chunk("IEND",Buffer.alloc(0));
  const source=Buffer.concat([head,image,exif,end]);
  const clean=stripImageMetadata(source,"image/png");
  assert.equal(detectMediaType(clean),"image/png");
  assert.equal(clean.includes(Buffer.from("GPSLocation")),false);
  assert.equal(clean.includes(Buffer.from("IDAT")),true);
  assert.equal(clean.includes(Buffer.from("IEND")),true);
});

test("video probe enforces actual duration, stream and dimensions", () => {
  const valid={format:{duration:"32.5"},streams:[{codec_type:"video",width:1920,height:1080}]};
  assert.deepEqual(validVideoProbe(valid),{durationMs:32500,width:1920,height:1080});
  assert.equal(validVideoProbe({format:{duration:"121"},streams:[{codec_type:"video",width:1920,height:1080}]}),null);
  assert.equal(validVideoProbe({format:{duration:"2"},streams:[{codec_type:"audio"}]}),null);
  assert.equal(MAX_VIDEO_DURATION_MS,120000);
});

test("JPEG EXIF and IPTC segments are stripped without removing image data", () => {
  const segment=(marker:number,data:Buffer)=>{const out=Buffer.alloc(4+data.length);out[0]=0xff;out[1]=marker;out.writeUInt16BE(data.length+2,2);data.copy(out,4);return out;};
  const source=Buffer.concat([Buffer.from([0xff,0xd8]),segment(0xe1,Buffer.from("GPS EXIF")),segment(0xed,Buffer.from("IPTC location")),segment(0xe0,Buffer.from("JFIF")),Buffer.from([0xff,0xda,0x00,0x02,0x11,0x22,0xff,0xd9])]);
  const clean=stripImageMetadata(source,"image/jpeg");
  assert.equal(clean.includes(Buffer.from("GPS EXIF")),false);
  assert.equal(clean.includes(Buffer.from("IPTC location")),false);
  assert.equal(clean.includes(Buffer.from("JFIF")),true);
  assert.equal(detectMediaType(clean),"image/jpeg");
});

test("WebP EXIF/XMP chunks and feature flags are removed", () => {
  const chunk=(name:string,data:Buffer)=>{const head=Buffer.alloc(8);head.write(name,0,"ascii");head.writeUInt32LE(data.length,4);return Buffer.concat([head,data,data.length%2?Buffer.from([0]):Buffer.alloc(0)]);};
  const vp8x=Buffer.alloc(10);vp8x[0]=0x0c;
  const chunks=[chunk("VP8X",vp8x),chunk("EXIF",Buffer.from("GPS")),chunk("XMP ",Buffer.from("location")),chunk("VP8 ",Buffer.from([1,2,3]))];
  const payload=Buffer.concat([Buffer.from("WEBP","ascii"),...chunks]);
  const head=Buffer.alloc(8);head.write("RIFF",0,"ascii");head.writeUInt32LE(payload.length,4);
  const clean=stripImageMetadata(Buffer.concat([head,payload]),"image/webp");
  assert.equal(clean.includes(Buffer.from("GPS")),false);
  assert.equal(clean.includes(Buffer.from("location")),false);
  assert.equal(clean[20]&0x0c,0);
  assert.equal(clean.readUInt32LE(4),clean.length-8);
  assert.equal(detectMediaType(clean),"image/webp");
});
