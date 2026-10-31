# agentduo desktop: ứng dụng Electron cho macOS, Windows và Linux

- **Ngày:** 2026-10-31
- **Trạng thái:** đã duyệt (plan v2 của pipeline `20261031-163905-trien-khai-app-desktop-agentduo-chay-tre`)
- **Bổ sung cho:** [2026-10-28-agentduo-vscode-design.md](2026-10-28-agentduo-vscode-design.md) (worker, `RuntimeSession`, protocol, webview) và [2026-10-27-agentduo-channel-design.md](2026-10-27-agentduo-channel-design.md) (agentduo chỉ là kênh, không ép luật).

## 1. Mục tiêu và phạm vi

Một cửa sổ desktop dùng **chung engine** với CLI và extension: mở project, chat ba bên User–Claude–Codex, `/discuss`, `/pipeline`, dừng và tiếp tục phiên cũ, xem plan/diff/kết quả kiểm tra, Settings và onboarding. Bản đầu **yêu cầu** người dùng đã cài và đăng nhập Claude Code CLI và Codex CLI.

Ngoài phạm vi: tự cài CLI, quản lý credential, terminal nhúng, telemetry, sửa source/stage/commit trong app, đổi `paths.runs_dir` từ Settings, ký/notarize thật (chỉ cấu hình và tài liệu).

## 2. Package

- `apps/desktop`: package **private**, lockfile riêng, **không có dependencies runtime**. devDependencies chỉ gồm `electron`, `electron-builder`, `@electron/fuses`, `electron-updater` (bundle vào main, mục 9), `playwright` (kiểm thử). Năm runtime dependency của `agentduo` (ink, react, commander, yaml, ajv) giữ nguyên; root `files` không đổi.
- Cài theo thứ tự: `npm ci` ở root rồi `npm ci --prefix apps/desktop`. Desktop dùng TypeScript, Vitest, tsup/esbuild và `@types/node` của root.
- Build (`scripts/build.mjs`): `dist/main/index.cjs` và `dist/preload/index.cjs` (CJS, chỉ external `electron` và built-ins), `dist/renderer/*` (browser IIFE, phẳng, kèm codicons và giấy phép), `dist/runtime/` (worker ESM bundle mọi dependency, `package.json` tên `agentduo`, `schemas/`).
- Version của desktop manifest và lockfile luôn bằng root; `npm version` đồng bộ qua `scripts/sync-vscode-version.mjs`.

## 3. Kiến trúc

- **Main** sở hữu cửa sổ, project/session, dialog, resource, diagnostics và bridge. Mỗi project (đường dẫn canonical, id là hash 16 hex) có một `WorkspaceSession` và một worker. Chuyển view không đóng conversation; quit/restart lưu view, giải quyết câu hỏi đang chờ theo broker, dừng cây tiến trình và nhả lock.
- **Worker**: `WorkerClient` có launch mode tường minh. Extension giữ Node ngoài; desktop fork bằng `process.execPath` với `ELECTRON_RUN_AS_NODE=1`, kiểm tra Node đi kèm ≥ 22.12, không bao giờ tìm Node hệ thống. Sau khi IPC khởi động, worker bỏ các biến nội bộ của Electron/IPC khỏi môi trường của agent và gate.
- **PATH khi mở từ launcher**: resolver async có timeout: binary đã cấu hình → PATH hiện có → PATH của login shell (POSIX, lệnh cố định, không nội suy dữ liệu người dùng) → thư mục cài phổ biến. Windows chuẩn hoá `PATH`/`Path`/`PATHEXT` và giữ nhánh `.cmd`/`.bat` hiện có.
- **Renderer**: `contextIsolation`, `sandbox`, không `nodeIntegration`, CSP chặt, nạp từ `agentduo://app/`. Tái dùng `createUi`/`reduce`/`render`/`markdown`/`uploads` của webview VS Code qua một adapter `Actions` riêng (không giả lập `acquireVsCodeApi`). Theme ánh xạ token sáng/tối sang `--vscode-*`.

## 4. IPC

- Preload expose đúng hai thứ: `invoke(request)` (kênh `agentduo:invoke`) và `onEvent(listener)` có unsubscribe (kênh `agentduo:event`). Không có filesystem, shell hay `ipcRenderer` tổng quát.
- `src/shared/protocol.ts` định nghĩa `DesktopRequest`/`DesktopResults`/`DesktopEvent` và `parseDesktopRequest`: kiểm tra sender (cửa sổ của app, top frame, origin `agentduo://app`), kiểu và kích thước payload, id do main cấp (project, conversation, change list, view/generation). Renderer không bao giờ gửi đường dẫn.
- Kết quả là `{ ok, result } | { ok: false, error }`, không ném exception qua IPC. Ảnh đính kèm xem qua token `agentduo://resource/<token>`, kiểm tra lại khi nạp (trong thư mục của conversation sau khi resolve symlink, đúng ảnh raster), thu hồi khi view đổi.

## 5. Settings

Ba lớp engine: defaults ← global (`~/.agentduo/config.yaml`) ← project (`<project>/.agentduo/config.yaml`), cộng session override; preferences riêng của desktop (theme, cỡ chữ, recipient mặc định) ở `userData`.

- `readConfiguration`/`updateConfiguration`/`clearConfiguration` (`src/core/configuration.ts`) là thao tác file: không cần conversation, không lấy workspace lock, không tạo Chat; worker trả lời chúng cả trước `initialize` (protocol 9). Không có project thì chỉ đọc/ghi global.
- Ghi: candidate được merge và `validateConfig` trước, ghi atomic, giữ comment YAML. YAML không parse được: hiện lỗi và vị trí, mở đúng file, không ghi đè. Reset dùng `deleteIn` (không ghi `null` để kế thừa). `args` là mảng thay nguyên key; `role_args` theo từng role.
- Thay đổi hiệu lực được áp **in-place** vào `cfg.claude`/`cfg.codex` (giữ identity backend) và idempotent khi replay.
- Một lần ghi file đến được mọi worker đang chạy qua `syncConfiguration`: sau khi ghi user config (từ Settings của bất kỳ project nào, từ main khi không có project, hay từ bộ chọn CLI), main gửi nó tới worker của **mọi** project đang mở; ghi file project thì tới worker của project đó. Lệnh trong composer (`/codex model … --global`) hay menu settings của chat với Global ghi user config trong worker của project đó: worker gửi `configWritten`, main gửi `syncConfiguration` tới worker của các project còn lại. Một thay đổi setting trong chat (gõ lệnh, menu, Shift+Tab) đến các chat khác của cùng worker qua `ChatOptions.changed`; ghi file xong, worker cập nhật `seen` theo file mới. Worker so file với lần đọc trước (`seen`) và cho các chat theo từng key đã đổi, trừ key project tự đặt (giá trị merge không đổi) hoặc session có giá trị riêng.

**Thời điểm áp dụng** (`SettingChange.live`):

| Key | live | Áp dụng |
|---|---|---|
| `model`, `effort`, permission mode, `rules`, `add_dirs`, `args`, `role_args.<role>`, `bin`, `max_budget_usd`, `permission_prompts` | `next-call` | từ lần gọi agent kế tiếp, cả run đang chạy (cập nhật `config.json`) và khi resume; subprocess đang chạy không đổi |
| `agents.*`, mọi `limits.*` | `next-run` | chỉ công việc mới; run đang chạy, discussion đang diễn ra và run resume giữ giá trị đã lưu |

Process khác đang giữ lock vẫn cho lưu file, nhưng chỉ đọc lại khi khởi động lại; Settings nói rõ điều đó.

**Storage chỉ đọc**: hiện `runsDir` hiệu lực và nguồn, `userData`, nút mở thư mục; đổi `paths.runs_dir` phải sửa file khi mọi host đã đóng (lock nằm trong đó).

## 6. Onboarding và chẩn đoán

Onboarding kiểm tra hai CLI (missing / installed / signed-in / signed-out / unknown / error), không gọi model, có link hướng dẫn cài, cách đăng nhập, chọn binary (ghi global `<backend>.bin`) và Recheck, rồi chọn project. Diagnostics gom version, PATH và nguồn, trạng thái CLI, kết quả `duo doctor`; bản xuất được xem trước, không chứa credential, prompt, base64 hay attachment.

## 7. Đóng gói

- electron-builder 26: macOS dmg+zip arm64/x64, Windows NSIS x64, Linux AppImage+deb x64; chỉ lấy `dist/main`, `dist/preload`, `dist/renderer`, `package.json`; `dist/runtime` nằm ngoài ASAR ở `resources/runtime`.
- Fuses (`scripts/fuses.mjs`, hook `afterPack`, trước khi ký): **RunAsNode bật** (worker chạy bằng chính executable), `NODE_OPTIONS` và CLI inspector **tắt** ở bản release; profile test (`AGENTDUO_FUSES=test`) bật inspector cho Playwright. Đánh đổi: executable có thể đóng vai Node; hướng cải tiến là chuyển worker sang `utilityProcess`.
- macOS không có chứng chỉ: ad-hoc (`identity: "-"`), hardened runtime, entitlements tối thiểu; Developer ID và notarization cần chứng chỉ Apple riêng. Windows chưa ký nếu không có chứng chỉ. Linux `.deb` cài AppArmor profile và xử lý `chrome-sandbox` SUID; app không bao giờ tự tắt sandbox, chỉ test harness được opt-out (`AGENTDUO_E2E_NO_SANDBOX`).

## 8. Kiểm chứng

Root `typecheck`/`test`/`build`/`test:pack`, extension `typecheck:vscode`/`build:vscode`/`test:pack:vscode`, desktop `typecheck`/`test`/`build`/`test:e2e`/`pack:dir`/`test:pack`. CI native ba OS (`.github/workflows/desktop.yml`) cài root rồi desktop; `release.yml` (mục 9) chạy lại typecheck, test và smoke test trên từng bộ cài trước khi tải lên. `apps/desktop/VERIFICATION.md` chỉ ghi những gì đã thực sự chạy: OS/kiến trúc, dev/unpacked/installer, fake hay CLI thật, chế độ sandbox, kết quả và lệnh tái hiện; CI chưa chạy hoặc OS chưa thử không được ghi là đã kiểm chứng.

## 9. Tự cập nhật và phát hành

Bổ sung 2026-10-31, theo yêu cầu của người dùng trong chat (bỏ qua bước duyệt spec/plan riêng).

- **Nguồn:** các GitHub Release đã publish của `HaiTrieu247/agentduo` (`publish` trong `electron-builder.yml`). `electron-updater` 6.8 (devDependency, bundle vào `dist/main`) đọc feed `latest.yml` / `latest-mac.yml` / `latest-linux.yml`, kiểm sha512, không hạ phiên bản, bản stable bỏ qua pre-release. Đóng gói ghi feed và `app-update.yml` nhưng không bao giờ tự upload (`--publish never`).
- **Chế độ** (`updateMode`, `src/main/updates.ts`, không import Electron): `install` cho bản đóng gói trên Windows (NSIS), Linux (AppImage, deb) và Mac ký Developer ID; `notify` cho Mac ký ad-hoc (Squirrel.Mac chỉ nhận bản cùng Developer ID; `codesign -dv` cho biết) và cho test có feed riêng; `off` cho bản dev và profile test không có feed. Profile riêng (`AGENTDUO_DESKTOP_USER_DATA`) không bao giờ hỏi GitHub; nó chỉ đọc feed `AGENTDUO_DESKTOP_UPDATE_CONFIG` và không cài gì.
- **Lịch:** 15 giây sau khi mở, rồi mỗi 4 giờ, khi preference `autoUpdate` (mặc định bật) còn bật; *Check now* và menu *Check for Updates…* luôn kiểm tra được. Mỗi lúc chỉ một lần kiểm tra; khi đang tải hay đã sẵn sàng thì không kiểm tra lại.
- **Trạng thái** (`UpdateState`, có trong `AppSnapshot` và event `update`): off, idle, checking, latest, downloading (phần trăm), ready, manual (phiên bản và lý do), error (câu dễ đọc: chưa có release, release chưa có bộ cài cho hệ này, không có mạng, GitHub giới hạn request, hoặc dòng đầu của lỗi).
- **Cài:** `update.install` chỉ nhận khi ready. App thoát như Quit (worker trả lời câu hỏi đang mở, dừng run, nhả lock), rồi lúc thoát `installAtQuit` giao cho installer (`quitAndInstall(true, true)`), installer khởi động bản mới. Installer từ chối thì app thoát như thường. Renderer hỏi trước nếu agent đang làm việc. Thoát mà không restart vẫn cài (`autoInstallOnAppQuit`), trừ `.deb` (cài bằng `pkexec`, chỉ khi người dùng bấm restart). AppImage luôn dùng `AppImageUpdater`, dù `.deb` build từ cùng thư mục có để lại `package-type`.
- **IPC:** `update.check`, `update.install` (không tham số), link `agentduo-releases`, preference `autoUpdate`, menu `checkUpdates`. UI: thẻ Updates trong Settings → General; nút ở cuối sidebar chỉ khi cần người dùng (*Restart to update*, *Get AgentDuo x.y.z*).
- **Phát hành** (`.github/workflows/release.yml`, khi push tag `v*`): job `draft` kiểm tag bằng version của cả hai `package.json` rồi tạo draft release; `build` trên ba hệ điều hành chạy typecheck, test, `package:<os>`, `test:pack`, rồi tải bộ cài, blockmap và feed lên draft; `publish` chỉ publish khi đủ ba feed. Ký app là tuỳ chọn: secret nào có mới đưa vào môi trường (secret trống sẽ bị electron-builder hiểu là chứng chỉ). npm và VS Code Marketplace vẫn phát hành tay.
