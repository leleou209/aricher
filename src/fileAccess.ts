// 云盘文件的房间约定与读取权限。
//
// R2 是同一只桶，但屋子是分开的：文件 key 一律带上归属房间的前缀
// （f/<DO 名>/…），读取时管理员全库可见，来客只能读自己那间画出来/存下来的。
// 没有前缀的老对象（前缀约定之前的存量）对来客一律不可见 —— 那些图他本来也
// 看不了（/api/files 曾是管理员专属），不是回退，是把「看不了」的原因写明。
//
// key 里同时带一段随机量：光有时间戳的话，毫秒级枚举就能撞到别人的文件名。

/** 某间屋子的文件都住在这个前缀下（尾斜杠保证前缀匹配不会撞进相似房间名） */
export function roomKeyPrefix(room: string): string {
  return `f/${room}/`;
}

/**
 * 公开空间：key 在这个前缀下的文件，登录进来的人谁都读得到。
 * 不是一间「屋子」——没有门票指向它，它只是把「愿意给所有人看的」
 * 和「只属于某间屋的」在 key 上分开。permPublic 权益管的是谁能往里放。
 */
export const PUBLIC_PREFIX = "f/public/";

/** 给某间屋子生成一个新文件 key：f/<room>/<base>-<时间戳>-<随机段>.<ext> */
export function scopedKey(room: string, base: string, ext: string): string {
  const rand = crypto.randomUUID().slice(0, 8);
  return `${roomKeyPrefix(room)}${base}-${Date.now()}-${rand}.${ext}`;
}

/** 谁能读这个 key：管理员全库可见；来客读自己房间前缀下的，公开空间人人都读得 */
export function canReadFile(
  key: string,
  role: "admin" | "user",
  room: string,
): boolean {
  if (role === "admin") return true;
  if (key.startsWith(PUBLIC_PREFIX)) return true;
  return key.startsWith(roomKeyPrefix(room));
}

/**
 * 云盘对象响应的通用头。
 *
 * HTML / SVG / XHTML 是「当文档打开就跑脚本」的东西，响应一律压进 CSP sandbox
 * （不透明源）：就算有人把链接发给管理员点开，页面里的脚本也拿不到同源
 * 权限，调不了带 cookie 的管理接口。SVG 是图纸工具的直接产物——来客画得
 * 出来、管理员点得开，它跟 text/html 一样是文档，不是图片。
 * 判断按去参数后的媒体类型来：上传存的类型可能带着 `; charset=utf-8`，
 * 精确匹配会把这一类漏到 sandbox 外面去。
 */
export function fileResponseHeaders(
  contentType: string,
  isPublic = false,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    // 私有对象的同一 URL 可能在同一浏览器中跨登录态复用，不交给共享或本地缓存。
    "Cache-Control": isPublic
      ? "public, max-age=86400, immutable"
      : "private, no-store",
  };
  const media = contentType.split(";")[0].trim().toLowerCase();
  const asDocument =
    media === "text/html" ||
    media === "image/svg+xml" ||
    media === "application/xhtml+xml";
  if (media.startsWith("image/") || asDocument)
    headers["x-robots-tag"] = "noindex";
  if (media.startsWith("image/")) headers["Content-Disposition"] = "inline";
  if (asDocument) headers["Content-Security-Policy"] = "sandbox allow-scripts";
  return headers;
}
