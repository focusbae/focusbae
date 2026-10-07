"use strict";
// Generate shipped icons from the selected vector sources. Run from any cwd.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const web = path.resolve(root, "../focusbae-web");
const source = (name) => fs.readFileSync(path.join(root, "brand", `${name}.svg`), "utf8");
const dest = (...parts) => path.join(root, ...parts);
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}
async function main() {
  const appIcon = source("soft");
  const flat = source("editorial");
  const small = source("small");
  const tray = source("tray");
  write(dest("build/icons/focusbae-icon.svg"), appIcon);
  write(dest("tray-icon-template.svg"), tray);
  write(dest("desktop-ui/src/brand-mark.svg"), flat);
  const withWeb = fs.existsSync(path.join(web, "package.json"));
  if (withWeb) {
    write(path.join(web, "public/brand/mark.svg"), flat);
    write(path.join(web, "public/icon.svg"), small);
  }
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  async function render(svg, size) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><head><style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style></head><body>${svg}</body></html>`);
    return page.screenshot({ omitBackground: true });
  }
  try {
    const mainPngs = new Map();
    for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
      const png = await render(size <= 32 ? small : appIcon, size);
      mainPngs.set(size, png);
      write(dest(`build/icons/icon-${size}.png`), png);
    }
    write(dest("build/icons/icon.png"), mainPngs.get(1024));
    write(dest("build/icons/icon-1024-circle.png"), mainPngs.get(1024));
    write(dest("build/icons/icon.ico"), ico([16, 32, 48, 256].map(size => ({ size, png: mainPngs.get(size) }))));
    const iconset = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-iconset-"));
    try {
      const set = path.join(iconset, "icon.iconset");
      fs.mkdirSync(set);
      for (const [name, size] of Object.entries({
        "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
      })) write(path.join(set, name), mainPngs.get(size));
      execFileSync("iconutil", ["-c", "icns", set, "-o", dest("build/icons/icon.icns")]);
    } finally {
      fs.rmSync(iconset, { recursive: true, force: true });
    }
    const tray1 = await render(tray, 18);
    const tray2 = await render(tray, 36);
    for (const name of ["tray-icon.png", "iconTemplate.png"]) write(dest(name), tray1);
    for (const name of ["tray-icon@2x.png", "iconTemplate@2x.png"]) write(dest(name), tray2);
    const favicons = [];
    for (const size of [16, 32, 48, 256]) favicons.push({ size, png: await render(size <= 32 ? small : flat, size) });
    if (withWeb) {
      write(path.join(web, "public/favicon.ico"), ico(favicons));
      write(path.join(web, "public/apple-touch-icon.png"), await render(flat, 180));
    }
    console.log(`Generated FocusBae app and tray icons${withWeb ? ", plus website icons" : ""}.`);
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
