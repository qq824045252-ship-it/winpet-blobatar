# Third-Party Notices / 第三方软件声明

本文件列出本项目直接依赖的第三方组件及其许可信息。本声明仅适用于下列第三方组件本身，不代表 WinPet 项目整体采用相同许可证。

This file lists third-party components directly used by this project. It applies only to those components, not to the WinPet project as a whole.

---

## Blobatar / @blobatar/react

- **npm 包名 / Package Names**: `blobatar`、`@blobatar/react`
- **本项目锁定/使用版本 / Version in use**: **2.2.0**
  - 依据：`package.json: dependencies "@blobatar/react": "^2.2.0", "blobatar": "^2.2.0"` + `package-lock.json: "node_modules/blobatar": {"version":"2.2.0"}` / `"node_modules/@blobatar/react": {"version":"2.2.0"}` + `node_modules/blobatar/package.json: "version":"2.2.0"` + `node_modules/@blobatar/react/package.json: "version":"2.2.0"`（四处一致）
- **上游 / Upstream**: https://github.com/Alain00/blobatar
  - `blobatar/package.json: repository.url: git+https://github.com/Alain00/blobatar.git (directory: packages/blobatar)`
  - `@blobatar/react/package.json: repository.url: git+https://github.com/Alain00/blobatar.git (directory: packages/react)`
  - `homepage: https://github.com/Alain00/blobatar#readme`
- **作者 / Author**: Alain（`package.json: "author":"Alain"`）
- **版权 / Copyright**: 以 `node_modules/blobatar/LICENSE` 实际文本为准：`Copyright (c) 2026 Alain`
- **许可证 / License**: **MIT License**
- **引用方式 / Usage in this repo**: 通过 `npm install` 以 **npm 依赖调用**方式使用，未复制、未修改上游源码（仓库内无 `blobatar` 源码拷贝，仅 `node_modules` 安装产物；源码仅通过 `import` 调用，见 `src/App.jsx:2,3,6`）

### 本项目实际调用清单（以源码为准）
- `src/App.jsx:2` `import { Blobatar } from "@blobatar/react"` — 角色渲染组件
- `src/App.jsx:3` `import "blobatar/motion.css"` — 表情动画样式
- `src/App.jsx:4-6` `import { idle, happy, sad, mad, surprised, scared, sick, sleepy, thinking, wink, smug, love, shy, unsure } from "blobatar/expression"` — 14 个表情常量
- `src/App.jsx:152` `<Blobatar name={name} size={72} expression={activeExpr} animate="always" />`

`@blobatar/react` 的 `peerDependencies: {"blobatar":"2.x"}` 要求两者同主版本，本项目均使用 `2.2.0` 满足。

---

## MIT License 原文（来自 `node_modules/blobatar/LICENSE`，原样保留）

```
MIT License

Copyright (c) 2026 Alain

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR OTHER DEALINGS IN THE SOFTWARE.
```

`@blobatar/react` 同为同一作者、同一 MIT 文本（`node_modules/@blobatar/react/LICENSE` 内容一致）。

---

## 关于 WinPet 项目自身许可

- WinPet（本仓库 `winpet-blobatar`，`productName: WinPet`）**尚未单独声明开源许可证**，除上述第三方组件按其各自许可证（MIT）使用外，其余代码与资源**保留所有权利（All Rights Reserved）**。
- 本文件不构成对 WinPet 整体以 MIT 许可的授权，引用 Blobatar 不代表 WinPet 整体为 MIT。
