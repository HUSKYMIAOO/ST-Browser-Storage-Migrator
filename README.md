# ST Browser Storage Migrator v1.0.3

迁移当前 SillyTavern Origin 下实际存在的 LocalStorage、SessionStorage 和全部 IndexedDB。

## UI
- 入口为简洁的 `⇄` 圆形悬浮图标。
- 支持鼠标/触摸拖动，手机 Safari 可移动到不遮挡其他按钮的位置。
- 导入/导出按钮使用高对比度文字。

## 安装
将本目录作为 SillyTavern 第三方扩展安装。GitHub 仓库根目录必须直接包含 manifest.json、index.js、style.css、README.md。

### v1.0.3 更新
- 修复悬浮按钮位于画面边缘时，展开面板后无法正常拖动的问题。
- 面板展开后，可继续拖动圆形 ⇄ 按钮。
- 新增面板标题栏拖动区域（⠿）。
- 面板会自动翻转/贴边，尽量保持在可视区域内。
