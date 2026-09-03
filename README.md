# 浏览器存档迁移 / Browser Storage Migrator

用途：
- 在不同浏览器、电脑与 iPhone Safari 之间迁移同一个 SillyTavern 站点的浏览器本地状态。
- 导出/导入 LocalStorage、SessionStorage，以及当前 Origin 下**实际存在的全部 IndexedDB 数据库**。
- 不依赖固定数据库名；数据库可能叫任何名字，也可能当前一个 IndexedDB 都没有。

工作方式：
- 支持 `indexedDB.databases()` 的浏览器：自动枚举当前站点现有的全部 IndexedDB。
- 不支持自动枚举的浏览器：会提示手动填写数据库名；如果没有需要迁移的 IndexedDB，可直接取消。
- 不会假设某个特定插件、记忆框架或角色卡数据库一定存在。

安装：
1. 解压 ZIP。
2. 将整个扩展文件夹放到 SillyTavern 的第三方扩展目录。
3. 重启 SillyTavern。
4. 页面右下角会出现“⇄ 存档迁移”。

使用：
- 源浏览器：点“⇄ 存档迁移” → “📤 导出备份”
- 目标浏览器：点“⇄ 存档迁移” → “📥 导入备份”
- 导入后关闭并重新打开 SillyTavern 页面。

iPhone Safari：
- 只要 iPhone Safari 访问的是安装了此扩展的同一个 SillyTavern 后端，页面会自动加载本扩展。
- iPhone 和电脑地址可能不同，例如电脑 `127.0.0.1:8000`、手机 `192.168.x.x:8000`。
  导入时会提示 Origin 不一致；确认确实是同一套 SillyTavern 后端后可以继续。

注意：
- 浏览器 Extension storage 不属于网页 Origin，普通 SillyTavern 前端扩展无权直接读取，因此不在备份范围内。
- 导入会覆盖当前 Origin 的 LocalStorage/SessionStorage，并覆盖备份中 IndexedDB Object Store 的数据。
- 在导入前建议先在目标浏览器也导出一次备份。
