# Dual Video Player の構成

Dual Video Player は、Master と Sub の動画を比較再生し、タイムスタンプとスクリーンショットを記録する Windows アプリです。今回確認した配布フォルダにはビルド設定と実行ファイルがありましたが、編集用のソースがありませんでした。更新を継続できるよう、配布物内のソースを復元し、Git 管理を設定しました。この資料は、復元した実装に基づいて構成とビルド方法を記録します。

## 技術スタックと依存関係

- JavaScript、HTML、CSS、Electron（開発依存 `^28.0.0`）。
- `ws`（`^8.16.0`）によるセッション通信。
- `electron-builder`（`^24.0.0`）による Windows x64 配布物作成。
- 依存関係の固定には `package-lock.json` を使用します。
- ffmpeg の検出・セットアップ機能があります。動画形式によって外部実行ファイルを使用します。
- Git サブモジュールはありません。

## 主要ファイル

| パス | 役割 |
| --- | --- |
| `src/main.js` | ウィンドウ、メニュー、設定、ファイル保存、IPC、動画処理 |
| `src/preload.js` | 画面に公開する Electron IPC API |
| `src/renderer.js` | 動画操作、TC、タイムスタンプ、CSV/TSV、セッション画面 |
| `src/index.html` | メイン画面とスタイル |
| `src/timestamp-window.html` | タイムスタンプの別ウィンドウ |
| `src/session-manager.js` | WebSocket のホスト・クライアント通信 |
| `package.json` / `package-lock.json` | 依存関係とビルド設定 |
| `BUILD.bat` / `BUILD-INSTALLER.bat` | Windows ビルド用の既存バッチ |
| `dist/` | 生成したアプリ。Git 対象外 |
| `node_modules/` | インストールした依存関係。Git 対象外 |

## 実行・ビルド

プロジェクトルートで実行します。

```powershell
npm ci
npm start
npm run build
```

`npm run build` は `dist/DualVideoPlayer.exe` を生成します。インストーラーは `npx electron-builder --win nsis --x64` で生成します。署名は設定されていません。

## データと CSV

タイムスタンプは renderer のメモリに保持します。アプリ終了後に復元する保存機能と CSV インポート機能はありません。設定は `dvp-settings.json`、スクリーンショットは設定された保存先を使用します。

CSV は動画先頭からの秒数を基準に、次の列順で出力します。

```text
id,timecode,offset_sec,by,memo,native,channel,stream_id,started_at,created_at,updated_at,deleted,clock_skew_ms
```

`timecode` と `offset_sec` は同じミリ秒丸め値から生成します。表示用 TC オフセットは適用しません。ID は実行中の同一記録で固定します。Twitch の情報や時計ずれなど、取得していない値は空欄です。ローカル記録の `native` と `deleted` は `false` です。CSV の再読込・削除同期は出力先システムの機能であり、本アプリでは実装していません。

TSV とクリップボードの既存形式は維持します。

## 復元元と管理

2026-09-28 に既存の `dist/win-unpacked/resources/app.asar` から `src/` の 6 ファイルを復元し、各ファイルの SHA-256 がアーカイブ内の値と一致することを確認しました。元の開発リポジトリは確認が必要です。ローカル Git を初期化し、非公開の `https://github.com/hakuseiyato/dual-video-player` を作成して `origin` に設定しました。2026-09-29 にユーザーからコミット・push と GitHub Release への配布を承認されました。配布ファイルは GitHub Release の添付ファイルで管理します。
