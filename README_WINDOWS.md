# WinPet Blobatar — Windows 使用
解压后在 Windows 上执行：

```powershell
cd winpet-blobatar
npm ci
npm run build        # 或 npm run tauri:dev 调试
npm run tauri:build  # 打包，产物在 src-tauri/target/release/bundle/msi|nsis/
```
需先装 Rust https://rustup.rs/ 与 Node.js 20+。
