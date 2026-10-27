# agentduo: chuyển orchestrator thành CLI npm có giao diện live

- **Ngày:** 2026-10-27
- **Trạng thái:** chờ duyệt
- **Thay thế:** bản Python trong `.orchestrator/` (commit `7559c70`)
- **Đặc tả hành vi gốc:** [docs/codex_claude_multi_agent_plan.md](../../codex_claude_multi_agent_plan.md)

## 1. Mục tiêu

Người dùng cài một lần (`npm i -g agentduo`) rồi chạy được trong bất kỳ git repository nào, không phải copy thư mục orchestrator vào repo. Giao diện terminal phải cho thấy:

- agent nào đang chạy (Codex hay Claude), trong vai trò gì, ở pha và vòng nào;
- agent đang làm gì, theo từng hành động (đọc file, tìm kiếm, sửa file, chạy lệnh);
- hai agent trao đổi gì với nhau: plan, phản biện, quyết định chốt, kết quả gate, finding của review, quyết định của người dùng;
- chi phí và token cộng dồn theo thời gian thực.

**Dành cho:** publish công khai trên npmjs.com.

**Tiêu chí thành công:**

1. Cài tarball bằng `npm pack` vào một prefix tạm. Sau đó `duo --version`, `duo doctor` và `duo "<task>"` chạy được trong một git repo bất kỳ mà không cần Python.
2. Đạt parity hành vi với bản Python: mọi kịch bản trong `tests/test_workflow.py` và `tests/test_units.py` đều có test tương ứng và đều pass (xem §9).
3. Trong TTY, mỗi bước hiển thị hoạt động thật lấy từ stream của CLI, cùng message "ai gửi gì cho ai", pipeline các pha và chi phí. Khi tới `HUMAN_REVIEW`, CLI hỏi ngay tại chỗ rồi chạy tiếp trong cùng tiến trình.
4. Ngoài TTY (CI, pipe, `--plain`), output là log dạng dòng, exit code giữ nguyên như bản Python.
5. `npm run smoke:real` (dùng Codex và Claude thật, task demo `calc.py`) chạy tới `DONE`.

**Không làm:**

- Không đọc hay chuyển đổi các run cũ trong `.orchestrator/runs/`.
- Không làm dashboard toàn màn hình, MCP server hay extension VS Code.
- Không tự commit, không tự push, không tự `npm publish`.
- Không cho thêm backend agent ngoài `codex` và `claude`.

## 2. Các quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Ngôn ngữ / runtime | Viết lại bằng TypeScript (strict, ESM) trên Node ≥ 20, build bằng `tsup` |
| UI | Ink + React: log giữ trong scrollback (`<Static>`) cộng một vùng live ở đáy. Có renderer plain cho môi trường không phải TTY |
| Dependency runtime | `ink`, `react`, `commander`, `yaml`, `ajv` (không thêm gì khác nếu chưa được đồng ý) |
| Tên | Package `agentduo`; binary `agentduo` và alias `duo` |
| HUMAN_REVIEW | Trong TTY thì hỏi ngay tại chỗ. Ở chế độ plain thì in hướng dẫn rồi exit 2. `duo resume --decision …` vẫn dùng được |
| Ngôn ngữ UI | Tiếng Anh. Prompt gửi agent là tiếng Anh |
| Nền tảng | macOS và Linux được hỗ trợ chính thức; Windows ở mức thử nghiệm |
| License | MIT |
| Bản Python | Giữ trong lịch sử git; xoá `.orchestrator/` và `tests/*.py` khi bản TypeScript đạt parity |

## 3. Cách dùng

```text
duo "<task>"                  # = duo run "<task>"; các tuỳ chọn: --task-file F, --allow-dirty, --plain, --verbose
duo resume [RUN_ID] [--decision resume|revise|abort] [--note TEXT] [--allow-dirty] [--plain]
duo status [RUN_ID]
duo list
duo doctor
duo init                      # tạo .agentduo/config.yaml (không ghi đè nếu đã có) và thêm .agentduo/runs/ vào .gitignore
```

Tuỳ chọn chung: `--repo PATH`, `--config PATH`, `--no-color` (đặt `NO_COLOR` cũng có tác dụng tương tự).

**Exit code:** `0` DONE · `1` lỗi cấu hình hoặc môi trường · `2` chờ HUMAN_REVIEW · `3` ABORTED · `130` bị dừng bởi `q` hoặc Ctrl-C (resume được).

**`duo init` tự đoán gates** theo thứ tự dưới đây, ghi tất cả gate tìm được với `required: true`:

1. `package.json`: các script `test`, `lint`, `typecheck` (hoặc `type-check`) → `npm run <script>`. Dùng `pnpm`/`yarn`/`bun` nếu thấy lockfile tương ứng.
2. `pyproject.toml`, `pytest.ini` hoặc `setup.cfg` có `[tool:pytest]` → `python3 -m pytest`.
3. `go.mod` → `go test ./...`
4. `Cargo.toml` → `cargo test`
5. `Makefile` có target `test:` → `make test`

Nếu không đoán được gate nào, `duo init` vẫn ghi config, kèm phần `gates` để trống có chú thích hướng dẫn và một cảnh báo. Khi đó lệnh `duo run` sẽ bị từ chối, vì `require_tests_pass` mặc định là `true`.

## 4. Kiến trúc

```text
src/
  cli.ts                 commander; chọn renderer Ink hoặc plain; nối event bus với renderer
  events.ts              union các kiểu sự kiện + EventBus (EventEmitter có kiểu)
  core/
    workflow.ts          state machine; phát sự kiện; gọi decide() khi HUMAN_REVIEW
    config.ts            giá trị mặc định, merge các nguồn, validate
    state.ts             RunStore: thư mục run, ghi atomic, lock, LATEST
    git.ts               snapshot qua index tạm, worktreeTree, nameStatus, diff, isIgnored
    guards.ts            protected paths (glob), giới hạn số file xoá, vị trí HEAD/branch
    gates.ts             chạy lệnh gate, timeout, kill process tree, lấy đoạn cuối output
    prompts.ts           port nguyên văn từ orch/prompts.py (gồm cả quy tắc lệnh ghép)
    render.ts            markdown cho plan, feedback, report
    init.ts              phát hiện gates cho `duo init`
  agents/
    types.ts             Activity, AgentResult, interface Backend
    runner.ts            spawn, đọc stream từng dòng, timeout, retry, validate bằng ajv, ghi log
    codex.ts             dựng lệnh codex exec --json …, parse JSONL
    claude.ts            dựng lệnh claude -p --output-format stream-json --verbose …, parse
    resolve.ts           tìm binary: PATH, ~/.claude/local, bản đi kèm extension IDE, shim .cmd trên Windows
  ui/
    ink/App.tsx          ghép StepBlock (tĩnh) + LiveFooter + HumanReviewPrompt
    ink/StepBlock.tsx  ink/LiveFooter.tsx  ink/HumanReviewPrompt.tsx
    plain.ts             renderer dạng dòng + decide() trả về "dừng"
schemas/*.json           5 schema strict, giữ nguyên nội dung từ bản Python
```

**Ranh giới:** `core/` và `agents/` không bao giờ import `ui/`. Mọi thứ hiển thị đều đi qua `EventBus`. Việc lấy quyết định của người dùng đi qua interface:

```ts
interface Decider { decide(review: HumanReview): Promise<Decision | "defer"> }
type Decision = { decision: "resume" | "revise" | "abort"; note?: string }
```

Khi nhận `"defer"`, workflow thoát với exit 2, giống bản Python. Khi nhận `Decision`, workflow gọi `applyDecision` rồi chạy tiếp vòng lặp.

**Dữ liệu theo repo** (repo chỉ chứa dữ liệu, không chứa code):

```text
<repo>/.agentduo/config.yaml          không bắt buộc
<repo>/.agentduo/runs/<run-id>/       artifacts, cùng bố cục với bản Python, thêm logs/*.events.jsonl
git refs: refs/agentduo/<run-id>/{base, impl-rN-pre, impl-rN}
```

**Nguồn config,** nguồn sau ghi đè nguồn trước (merge sâu, cảnh báo khi gặp khoá lạ):

1. giá trị mặc định trong code;
2. config user: `$XDG_CONFIG_HOME/agentduo/config.yaml`, mặc định `~/.config/agentduo/config.yaml`; trên Windows là `%APPDATA%\agentduo\config.yaml`;
3. `<repo>/.agentduo/config.yaml`;
4. `--config PATH` (thay cho mục 3 nếu có);
5. flag CLI (`--allow-dirty`, `--plain`, `--verbose`).

Các khoá config giống hệt bản Python (`agents`, `limits`, `permissions`, `quality_gates`, `gates`, `safety`, `codex`, `claude`, `paths`). Có hai thay đổi:

- `paths.runs_dir` mặc định là `.agentduo/runs`;
- `safety.protected_paths` mặc định dùng `.agentduo/**` thay cho `.orchestrator/**`.

Các luật validate giữ nguyên (implementer phải là Claude, các vai trò read-only phải chạy read-only…).

## 5. Lệnh gọi agent

Giữ nguyên các flag về quyền đã kiểm chứng ở bản Python. Chỉ đổi định dạng output sang stream.

| Vai trò | Lệnh |
|---|---|
| Codex (planner, finalizer, reviewer) | `codex exec --json --sandbox read-only --color never --output-schema <schema> --output-last-message <file> --cd <repo> [--model M] <extra_args> -` |
| Claude critic (read-only) | `claude -p --output-format stream-json --verbose --json-schema <json> --permission-mode dontAsk --permission-prompts none --tools Read,Grep,Glob --allowedTools Read Grep Glob <extra_args>` |
| Claude implementer | như dòng trên, nhưng `--permission-mode acceptEdits --tools <implementation_tools> --allowedTools <allowlist + Bash(<lệnh gate>*)> --disallowedTools <denylist>` |

Vai trò `plan_finalizer` dùng backend và quyền của `agents.planner`. Nó chỉ là một vai trò riêng trong prompt và trong sự kiện, giống bản Python.

Prompt được ghi vào stdin. Kết quả cuối, dùng để quyết định đúng/sai:

- Codex: nội dung file `--output-last-message`. Nếu file trống thì lấy `text` của `agent_message` cuối cùng.
- Claude: dòng `{"type":"result"}`, ưu tiên `structured_output`, sau đó mới tới `result`. Chi phí lấy từ `total_cost_usd`, danh sách bị từ chối lấy từ `permission_denials`.

Kết quả được validate bằng ajv theo schema, cộng thêm các check ngữ nghĩa như bản Python: `approved` phải khớp `status`, `reviewed_commit` phải đúng SHA, plan không được có trường bắt buộc rỗng, và `blocked` phải kèm lý do. Khi lỗi thì retry, gửi kèm lý do bị từ chối, tối đa `max_retries`.

**Timeout và huỷ:**

- POSIX: spawn với `detached: true`; khi cần dừng thì gửi `SIGTERM` cho process group, sau 5 giây mà chưa dừng thì gửi `SIGKILL`.
- Windows: `taskkill /PID <pid> /T /F`.

## 6. Mô hình sự kiện

```ts
type Role = "planner" | "plan_reviewer" | "plan_finalizer" | "implementer" | "code_reviewer";
type Party = "codex" | "claude" | "gates" | "human" | "orchestrator";

type Activity = {
  id: string;                      // id của tool_use (Claude) hoặc item.id (Codex)
  kind: "read" | "search" | "edit" | "command" | "say" | "think" | "submit" | "other";
  label: string;                   // ví dụ "Read  src/auth.ts", "Bash  npm test"
  status: "running" | "ok" | "error" | "denied";
  exitCode?: number; added?: number; removed?: number;
};

type Message = {
  from: Party; to: Party;
  kind: "plan" | "critique" | "approval" | "implementation" | "gates" | "review" | "decision";
  headline: string;                // một dòng
  items: string[];                 // các issue/finding/gate, mỗi phần tử một dòng, đã sắp theo severity
  artifact?: string;               // đường dẫn tương đối trong thư mục run
};

type DuoEvent =
  | { type: "run.started"; runId: string; task: string; repo: string; runDir: string }
  | { type: "phase.started"; step: number; phase: Phase; round: number; role?: Role; agent?: Party }
  | { type: "agent.activity"; role: Role; agent: Party; activity: Activity }   // phát lại khi status đổi
  | { type: "agent.retry"; role: Role; attempt: number; max: number; reason: string }
  | { type: "agent.usage"; agent: Party; costUsd?: number; tokens?: number }   // số cộng dồn của lần gọi
  | { type: "gate.started" | "gate.completed"; name: string; command: string; passed?: boolean; exitCode?: number | null }
  | { type: "message"; message: Message }
  | { type: "step.completed"; entry: HistoryEntry; durationSec: number; costUsd?: number; tokens?: number }
  | { type: "warning"; text: string }
  | { type: "human.required"; review: HumanReview }
  | { type: "run.finished"; phase: "DONE" | "ABORTED" | "HUMAN_REVIEW" | "INTERRUPTED"; reportPath: string; exitCode: number };
```

**Chuyển stream thành `Activity`:**

| Nguồn | Sự kiện gốc | Activity |
|---|---|---|
| Claude | `assistant.tool_use` Read / Grep / Glob | `read` / `search`; label là đường dẫn tương đối với repo hoặc pattern. Ghép với `tool_result` theo `tool_use_id`: thành `ok`, hoặc `error` nếu `is_error` |
| Claude | `tool_use` Edit / MultiEdit / Write | `edit`. `added`/`removed` = số dòng của `new_string`/`old_string`, hoặc của `content` nếu là Write |
| Claude | `tool_use` Bash | `command`; label là dòng đầu của `command` |
| Claude | `tool_use` StructuredOutput | `submit` ("submitting result") |
| Claude | khối `text` / `thinking` | `say` (dòng đầu, tối đa 120 ký tự) / `think` |
| Claude | lời gọi tool bị từ chối (có trong `permission_denials`, hoặc `tool_result` chứa thông báo bị từ chối) | đổi activity tương ứng sang `denied` |
| Codex | `item.started` / `item.completed` có `type: command_execution` | `command`; label lấy từ `command`, bỏ vỏ `/bin/zsh -lc '…'`; `ok` khi `exit_code` là 0, ngược lại là `error` |
| Codex | `item.completed` có `type: agent_message` | `say` |
| Codex | `item.*` có `type: reasoning` | `think` |
| Codex | `item.*` có `type: file_change` | `edit` (không xảy ra ở chế độ read-only, nhưng vẫn hiển thị để thấy vi phạm) |
| Codex | `turn.completed.usage` | `agent.usage` với `tokens = input_tokens + output_tokens` |
| Cả hai | dòng không parse được / loại sự kiện lạ | bỏ qua trên UI, vẫn lưu nguyên vào `events.jsonl` |

**Message được phát khi mỗi bước kết thúc:**

| Bước | Message |
|---|---|
| PLAN | `codex → claude` plan: `Plan vN "<title>" · S steps · A criteria · R risks`; items là các mục `feedback_resolution` |
| PLAN_REVIEW | `claude → codex` critique: `approved` hoặc `changes requested · B blocking`; items là các issue `[sev] id description` |
| PLAN_FINALIZE | `codex → claude` approval: `plan finalized vN` hoặc `changes requested`; items là các issue |
| IMPLEMENT | `claude → codex` implementation: `completed · F files changed` hoặc `blocked: <lý do>`; items là các `addressed_findings` |
| VERIFY | `gates → codex` gates: `tests ✓ · lint ✗ (exit 1)` |
| CODE_REVIEW | `codex → claude` review: `approved` hoặc `N findings · B blocking`; items là các finding `[sev] id file:line issue` |
| quyết định | `human → orchestrator` decision: `<decision> · "<note>"` |

## 7. Giao diện

**TTY:** dùng renderer Ink khi stdout là TTY, trừ khi có `--plain` hoặc `CI=true`. Phím tắt và HumanReviewPrompt còn cần stdin là TTY. Nếu stdin không phải TTY, Ink vẫn vẽ log và vùng live, nhưng `decide()` trả về `"defer"`.

- **Header**, in một lần: `agentduo vX · run <id> · <repo>`.
- **StepBlock**, in tĩnh khi `step.completed`:
  - dòng tiêu đề `● <PHASE> r<N>  <Agent> (<role>)` căn phải thời lượng, chi phí, token;
  - các activity, mặc định chỉ giữ 6 dòng cuối kèm dòng `… K more`, còn `--verbose` hoặc phím `v` thì giữ hết;
  - message kèm tối đa 5 items.
- **LiveFooter**, cập nhật khoảng 10 lần/giây:
  - pipeline `PLAN › CRITIQUE › FINALIZE › IMPLEMENT › VERIFY › REVIEW`, mỗi pha có dấu ✓ (đã qua), ● (đang chạy) hoặc trống (chưa tới), kèm `plan i/N · impl j/M`;
  - dòng spinner `⠋ <Agent> (<role>) · m:ss`, cùng 3 activity gần nhất;
  - tổng chi phí Claude và tổng token Codex;
  - gợi ý phím.
- **Phím tắt** (chỉ khi stdin là TTY):
  - `v`: bật/tắt chế độ chi tiết.
  - `q`: dừng an toàn sau khi bước hiện tại xong, exit 130.
  - `Ctrl-C`: kill agent hoặc gate đang chạy, lưu state, exit 130. Cấu hình Ink với `exitOnCtrlC: false` và tự xử lý; bấm Ctrl-C lần thứ hai thì thoát ngay.
- **HumanReviewPrompt**, khi `human.required`:
  - hiện `reason`, `message`, `details`;
  - menu chọn bằng phím mũi tên, gồm: Resume · Revise · View final plan · View last review · View plan feedback · View diff stat · Abort · Decide later.
  - Chọn Resume hoặc Revise thì có thêm ô nhập ghi chú (Enter để bỏ trống).
  - Các mục "View" in nội dung artifact thành một khối tĩnh trong scrollback rồi quay lại menu; mục nào chưa có artifact thì ẩn.
  - "Decide later" trả về `"defer"`.

**Plain:**

- Mỗi sự kiện là một dòng, dạng `HH:MM:SS  <agent padded>  <PHASE rN>  <text>`.
- `agent.activity` chỉ in khi status chuyển sang trạng thái kết thúc (`ok`/`error`/`denied`).
- Message in nhiều dòng, các items thụt lề.
- Không có vùng live và không xử lý phím. Lệnh `decide()` luôn trả về `"defer"`.
- Không có màu khi đặt `NO_COLOR` hoặc `--no-color`.

## 8. Lỗi và an toàn

Giữ nguyên toàn bộ ngữ nghĩa của bản Python:

- các lý do escalate (`max_planning_rounds`, `plan_ready`, `max_review_rounds`, `critical_finding`, `gates_failing`, `implementer_blocked`, `dirty_worktree`, `guard_violation`, `readonly_violation`, `agent_error`, `orchestrator_error`);
- bảng hành vi của `resume`/`revise`/`abort`;
- kiểm tra read-only bằng hash tree;
- guard sau mỗi lần implement;
- bỏ các pathspec exclude đã bị git ignore;
- từ chối chạy khi working tree bẩn (bỏ qua `.agentduo/`);
- không bao giờ commit.

Những lỗi chỉ ảnh hưởng tới hiển thị (stream hỏng, loại sự kiện lạ) không được làm đổi kết quả của bước. Exception không lường trước trong một bước sẽ chuyển thành `orchestrator_error`, kèm stack trace ghi vào `logs/error-stepNNN.txt`.

`duo doctor` kiểm tra:

- Node ≥ 20 và git;
- repo và config hợp lệ, 5 schema đều strict;
- binary của từng backend, version, và các flag `--json`, `--output-schema`, `--sandbox`, `--output-last-message`, `--cd` (Codex) cùng `--output-format`, `--verbose`, `--json-schema`, `--permission-mode`, `--permission-prompts`, `--tools`, `--allowedTools`, `--disallowedTools` (Claude);
- executable của từng gate;
- working tree sạch và `runs/` đã được git ignore.

Doctor không gọi model.

## 9. Kiểm thử

Dùng vitest. Lệnh `npm test` chạy toàn bộ những gì dưới đây, trừ smoke test thật.

- **Unit, port từ bản Python:** merge và validate config (gồm các cấu hình không an toàn và cảnh báo khoá lạ); tính strict của schema và lỗi validate; glob của protected path; `checkChanges`; snapshot git, cả khi `runs/` bị ignore lẫn không bị ignore; dựng lệnh cho từng backend; parse kết quả (fence, JSON lẫn trong text, envelope lỗi vẫn giữ chi phí); resolve binary bản đi kèm extension IDE, chọn version cao nhất.
- **Parse stream:** fixture lấy từ stream thật của codex-cli 0.164 và Claude Code 2.1.311, lưu ở `test/fixtures/*.jsonl`, đối chiếu với chuỗi `Activity` mong đợi. Thêm trường hợp dòng hỏng và loại sự kiện lạ.
- **End-to-end:** `test/fake-agent.mjs` thay cho `tests/fake_agent.py`, phát stream sự kiện thực tế cho từng backend theo kịch bản, cùng các hành động `write`/`delete`/`shell`/`raw`/`exit`. Port đủ các kịch bản trong `test_workflow.py`:
  - debate rồi fix loop tới DONE, có kiểm tra thứ tự lịch sử và nội dung prompt;
  - flag quyền theo vai trò;
  - vượt số vòng planning rồi resume hoặc revise;
  - vi phạm read-only;
  - output sai rồi được retry;
  - lỗi agent kéo dài;
  - finding critical;
  - protected path kết hợp tự commit;
  - implementer blocked;
  - gates fail liên tiếp;
  - vượt số vòng review rồi abort;
  - `pause_before_implement`;
  - working tree bẩn;
  - finding mức medium không chặn;
  - `status` và `list`.
- **Kịch bản mới:** `Decider` trả về quyết định ngay trong tiến trình; chạy tiếp mà không thoát; `q` dừng sau bước hiện tại; Ctrl-C kill agent rồi resume được.
- **UI:** dùng `ink-testing-library`, kiểm tra frame có StepBlock (activity, message), LiveFooter (pipeline, spinner, chi phí) và luồng chọn menu của HumanReviewPrompt. Renderer plain được kiểm tra bằng golden output.
- **Đóng gói:** `npm pack`, cài vào một prefix tạm, rồi chạy `duo --version` và `duo doctor --repo <tmp repo>`.
- **Thật (thủ công, tốn phí):** `npm run smoke:real` tạo repo demo `calc.py` và chạy với CLI thật tới DONE.
- **CI:** `.github/workflows/ci.yml` chạy typecheck, test và smoke test pack trên `ubuntu-latest` và `macos-latest`, Node 20 và 22.

## 10. Phát hành và thay thế bản Python

- **`package.json`:**
  - `"name": "agentduo"`, `"version": "0.1.0"`, `"type": "module"`, `"engines": { "node": ">=20" }`;
  - `"bin": { "agentduo": "dist/cli.js", "duo": "dist/cli.js" }`;
  - `"files": ["dist", "schemas", "README.md", "README.vi.md", "LICENSE"]`.
- `README.md` viết tiếng Anh cho trang npm. `README.vi.md` là bản tiếng Việt, cập nhật từ README hiện tại.
- `AGENTS.md` cập nhật theo stack mới. `CLAUDE.md` vẫn chỉ là `@AGENTS.md`.
- Mình chỉ chạy tới `npm publish --dry-run`. Lệnh `npm publish` thật và các bước tài khoản npm do người dùng làm.
- **Thứ tự:**
  1. Dựng package TypeScript ở gốc repo, song song với bản Python.
  2. Khi toàn bộ test TypeScript và smoke test thật đã xanh, xoá `.orchestrator/` và `tests/`.
  3. Commit trên nhánh tính năng, không commit thẳng lên `main`.

## 11. Rủi ro

- **Định dạng stream của CLI có thể đổi giữa các version.** Giảm thiểu: chỉ dùng stream cho hiển thị; fixture có ghi version; `duo doctor` kiểm tra flag; sự kiện lạ thì bỏ qua thay vì làm hỏng run.
- **Alias `duo` có thể trùng với binary khác trên máy người dùng.** Giảm thiểu: `agentduo` luôn dùng được, README ghi chú về việc trùng tên.
- **Vùng live của Ink có thể nhấp nháy trên terminal hẹp hoặc chậm.** Giảm thiểu: giới hạn tốc độ vẽ khoảng 10 lần/giây, cắt dòng theo chiều rộng terminal, và luôn có `--plain`.
- **Windows chưa được CI kiểm chứng.** README ghi rõ là thử nghiệm.
