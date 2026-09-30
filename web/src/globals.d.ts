// vite define 注入的构建期常量（见 vite.config.ts）。
// 版本号唯一来源是 package.json 的 version；构建号是构建时的 git 短 hash。
declare const __APP_VERSION__: string;
declare const __GIT_HASH__: string;
