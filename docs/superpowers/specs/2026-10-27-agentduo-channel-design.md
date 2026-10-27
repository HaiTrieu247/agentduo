# agentduo v2: chỉ là kênh giao tiếp giữa Codex và Claude Code

- **Ngày:** 2026-10-27
- **Trạng thái:** chờ duyệt
- **Thay thế một phần:** [2026-10-27-agentduo-npm-cli-design.md](2026-10-27-agentduo-npm-cli-design.md). Spec cũ vẫn có hiệu lực ở những mục không bị nhắc tới dưới đây. Các mục bị thay: §2 (hàng "Bản Python" giữ nguyên, các hàng về an toàn bị thay), §3 (lệnh), §4 (dữ liệu theo repo, nguồn config), §5 (lệnh gọi agent), §8 (lỗi và an toàn).

## 1. Mục tiêu

agentduo là **kênh** giữa hai CLI. Nó:
- chuyển plan, phản biện, quyết định chốt, kết quả gate, review và finding qua lại theo hợp đồng JSON;
- điều phối vòng lặp và hỏi người dùng khi cần;
- hiển thị mọi thứ trên UI.

**Luật** (quyền, sandbox, điều được hay không được làm) thuộc về từng CLI và config của người dùng: `~/.codex/config.toml`, settings của Claude Code, `AGENTS.md`/`CLAUDE.md`. agentduo không chồng thêm luật riêng, không ép flag quyền, không chặn thay đổi.

**Tiêu chí thành công:**

1. Không còn flag quyền nào trong lệnh gọi CLI, chỉ có các flag giao thức ở §4 và `args`/`role_args` do người dùng đặt.
2. Không còn guard nào có thể dừng run. Các thay đổi đáng chú ý chỉ được báo dưới dạng cảnh báo: file ngoài workspace bị đổi, hoặc file bị đổi trong bước của vai trò chỉ đọc.
3. `duo` gọi ở thư mục nào thì làm việc trong đúng thư mục đó (§3).
4. Toàn bộ lỗi Minor và các điểm bị gác lại ở §6 đã được sửa hoặc xử lý như mô tả, mỗi mục có test.
5. Toàn bộ test, typecheck, `test:pack` và `smoke:real` đều pass.

## 2. Các quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Lớp an toàn riêng | Bỏ hết: flag quyền, guard, từ chối working tree bẩn, "hard rules" trong prompt, ràng buộc "implementer phải là Claude" |
| Quality gates | Tuỳ chọn. Mặc định `gates: []`, khi đó không có pha VERIFY. Có gate thì agentduo chạy và chuyển kết quả cho reviewer |
| Phạm vi | Workspace là thư mục hiện tại (hoặc `--dir`). Thay đổi ngoài workspace chỉ bị cảnh báo |
| Không có git | Báo lỗi kèm gợi ý. Trong terminal, `duo init` hỏi có muốn `git init` không |
| `package.json` repository/homepage/bugs | Để trống cho tới khi người dùng có URL repo |

## 3. Workspace

- **Thư mục workspace** `W` = `--dir PATH` nếu có, nếu không thì thư mục hiện tại. Không còn đi ngược lên thư mục gốc của git repo. `W` phải nằm trong một git repo, với `R` = thư mục gốc của repo đó; nếu không, lệnh `run`/`resume` báo lỗi: `<W> is not inside a git repository (run 'git init' here, or 'duo init' to be asked)`.
- **Codex và Claude chạy với `cwd = W`.** Codex nhận thêm `--cd W`.
- **Dữ liệu** nằm ở `W/.agentduo/` (`config.yaml`, `.gitignore`, `runs/`). `paths.runs_dir` tương đối thì tính từ `W`, và `~` ở đầu được mở rộng.
- **Snapshot và diff** dùng pathspec giới hạn trong `W` (tương đối với `R`; khi `W = R` thì là `.`). Diff gửi cho reviewer, diff stat và danh sách file đổi chỉ gồm thay đổi trong `W`.
- **Cảnh báo ngoài workspace.** Khi `W ≠ R`, trước và sau mỗi bước agent và mỗi lần chạy gate, agentduo tính tree của toàn repo. File ngoài `W` bị đổi thì phát sự kiện `warning` ("2 file(s) outside the workspace changed during IMPLEMENT: A ../shared/x.ts, …") và ghi vào report. Run không dừng.
- **Cảnh báo bước chỉ đọc.** Nếu tree trong `W` thay đổi trong bước của planner, plan critic, plan sign-off hoặc code reviewer, agentduo cũng phát `warning` ("Codex (code reviewer) changed files: …") và ghi report. Run không dừng. Snapshot dùng cho review vẫn lấy sau bước implement như cũ.
- **Lock** theo workspace (`W/.agentduo/runs/.lock`) cộng lock theo run. Hai workspace khác nhau trong cùng một repo có thể chạy song song; khi đó mỗi run thấy thay đổi của run kia qua cảnh báo ngoài workspace.

## 4. Gọi CLI và config

**Lệnh gọi** chỉ còn các flag giao thức:

| Vai trò | Lệnh |
|---|---|
| Backend `codex` | `codex exec --json --color never --output-schema <schema> --output-last-message <file> --cd <W> [--model M] <codex.args> <codex.role_args[role]> -` |
| Backend `claude` | `claude -p --output-format stream-json --verbose --json-schema <json> --permission-prompts none [--model M] [--max-budget-usd X] <claude.args> <claude.role_args[role]>` |

`--permission-prompts none` được giữ vì khi chạy không tương tác thì không có ai trả lời prompt quyền. Flag này không cấp hay cắt bớt quyền nào: thứ được phép chạy, thứ bị từ chối vẫn do settings của người dùng quyết.

`role` là khoá vai trò trong config (`planner`, `plan_reviewer`, `implementer`, `code_reviewer`). Bước plan sign-off dùng `role_args.planner`.

**Config** (các khoá còn lại giữ nguyên ý nghĩa như spec cũ):

```yaml
agents: { planner: codex, plan_reviewer: claude, implementer: claude, code_reviewer: codex }   # mỗi vai trò là codex hoặc claude
limits:
  max_planning_rounds: 4
  max_review_rounds: 5
  max_retries: 1
  max_consecutive_gate_failures: 3
  agent_timeout_sec: 1800
  agent_idle_timeout_sec: 900      # mới: không có output (stdout/stderr) trong N giây thì coi là treo; 0 = tắt
  gate_timeout_sec: 900
  max_diff_chars: 120000
  max_gate_output_chars: 6000
quality_gates: { require_plan_approval: true, require_tests_pass: true, require_codex_approval: true,
                 stop_on_critical_issue: true, blocking_severities: [critical, high], review_on_gate_failure: false }
gates: []                          # tuỳ chọn
safety: { pause_before_implement: false }
codex:  { bin: codex, model: null, args: [--ephemeral], role_args: {} }
claude: { bin: claude, model: null, max_budget_usd: null, args: [--no-session-persistence], role_args: {} }
paths:  { runs_dir: .agentduo/runs }
```

- Các khoá bị bỏ: `permissions.*`, `safety.allow_dirty_worktree`, `safety.max_deleted_files`, `safety.protected_paths`, `claude.read_only_tools`, `claude.implementation_tools`, `claude.implementation_allowed_tools`, `claude.implementation_disallowed_tools`, `codex.extra_args`, `claude.extra_args`. Config cũ còn các khoá này chỉ sinh cảnh báo "unknown config key", không lỗi. Riêng `codex.extra_args`/`claude.extra_args` được cảnh báo kèm gợi ý đổi thành `args`.
- `role_args` là một mapping từ vai trò sang danh sách chuỗi. Vai trò lạ thì báo lỗi config.
- `require_tests_pass` chỉ có hiệu lực khi có gate. Không còn lỗi "no required gate".
- Flag CLI bị bỏ: `--allow-dirty`, `--repo`. Flag mới: `--dir PATH`, và `--reload-config` cho `resume`.

**Config gắn với run:** lúc tạo run, agentduo ghi config đã merge vào `runs/<id>/config.json`. `resume` dùng file này; `resume --reload-config` thì đọc lại config hiện tại và ghi đè file. Nếu run không có `config.json` (run cũ), `resume` đọc config hiện tại.

**Bị từ chối quyền:**
- Activity `⊘ denied` vẫn hiển thị như cũ.
- Khi implementer kết thúc mà có lần bị từ chối, agentduo phát cảnh báo kèm gợi ý: `Claude was denied N tool call(s); allow them in your Claude Code settings (e.g. permissions.defaultMode "acceptEdits" or allow rules) or via claude.role_args.implementer`.
- `duo doctor` không đọc settings của Claude. Khi implementer là `claude` và `claude.args` cộng `claude.role_args.implementer` không chứa `--permission-mode`, `--allowedTools`, `--allowed-tools` hay `--dangerously-skip-permissions`, doctor in một dòng lưu ý (không đánh fail): `implementer edits rely on your Claude Code permission settings (e.g. permissions.defaultMode "acceptEdits"); without them every edit is denied in non-interactive mode`.

## 5. Vòng lặp, prompt và điều kiện DONE

- **Pha:** PLAN → PLAN_REVIEW → PLAN_FINALIZE → IMPLEMENT → VERIFY (chỉ khi `gates` không rỗng) → CODE_REVIEW → DONE.
- **Lý do escalate còn lại:** `max_planning_rounds`, `plan_ready`, `max_review_rounds`, `critical_finding`, `gates_failing` (chỉ khi có gate), `implementer_blocked`, `agent_error`, `orchestrator_error`.
- **Lý do bị bỏ:** `readonly_violation`, `guard_violation`, `dirty_worktree`.
- **DONE khi:**
  - (Codex approve hoặc `require_codex_approval: false`), và
  - không còn finding thuộc `blocking_severities`, và
  - (không có gate, hoặc `require_tests_pass: false`, hoặc mọi gate bắt buộc đều đạt).
- **Prompt** chỉ còn mô tả nhóm làm việc, vai trò, việc cần làm, quy tắc quyết định của vai trò (khi nào approve, cách đặt id issue/finding) và hợp đồng output (JSON khớp schema). Các phần bị bỏ:
  - `READONLY_RULES`;
  - các dòng "Hard rules" của implementer (never commit, protected paths, no network, chained commands);
  - câu "the orchestrator verifies the working tree…".
- **Quy tắc thay thế cho implementer:** chỉ còn "follow your own configuration and the repository's instructions (AGENTS.md / CLAUDE.md)", và nếu có gate thì "these commands will be run after your turn: …".
- **Re-plan** (`revise`, hoặc chốt lại plan sau khi đã implement) xoá `lastGates` và `consecutiveGateFailures`.

## 6. Sửa lỗi nhỏ và các điểm bị gác lại

Mỗi mục có ít nhất một test, viết trước và phải thấy fail trước khi sửa.

| # | Mục | Hành vi sau khi sửa |
|---|---|---|
| 1 | `NO_COLOR` ở chế độ Ink | Khi có `NO_COLOR` hoặc `--no-color`, đặt `FORCE_COLOR=0` trước khi import session Ink, nên output không có mã màu |
| 2 | Ink không hiện retry | `agent.retry` thành một activity `↻ retry N/M: <dòng đầu của lý do>` (trạng thái error) trong step hiện tại |
| 3 | Lý do review bị ẩn | Khi `human.required` mà UI không tương tác, hoặc người dùng chọn "Decide later", UI in một khối tĩnh gồm reason, message, details |
| 4 | Ctrl-C tại menu quyết định | Tương đương "Decide later": không "lên đạn" interrupt; exit 2 |
| 5 | `--task-file` không tồn tại | `error: cannot read task file <path>: <lý do>`, exit 1, không in stack trace |
| 6 | Task bắt đầu bằng `-` | `duo -- "-x task"` hoạt động; README ghi cách dùng |
| 7 | Lệch cột ở chế độ plain | Cột agent rộng 12 ký tự, item thụt lề khớp theo |
| 8 | Log bị ghi đè khi chạy lại | Tiền tố log được chọn sao cho không trùng file đã có (thêm `-2`, `-3`…), và xoá `.last.json` cũ trước khi gọi Codex |
| 9 | Snapshot chậm | Index tạm được chép từ index thật (`git rev-parse --git-path index`) nếu có, nếu không thì dùng `read-tree HEAD` |
| 10 | Path có tab hoặc nháy | `name-status` và `status` dùng `-z` |
| 11 | Chờ cố định 50 ms khi đóng Ink | App báo đã vẽ xong dòng kết thúc (callback sau khi commit). `close()` đợi tín hiệu đó, tối đa 1 giây phòng khi không có `run.finished` |
| 12 | Spec cũ §10 `engines >=20` | Sửa thành `>=22.12` |
| 13 | Doctor và `runs_dir` | Mở rộng `~`. Kiểm tra git-ignore chỉ khi `runs_dir` nằm trong repo |
| 14 | Agent treo | `agent_idle_timeout_sec`: không có output trong N giây thì kill process tree. Lần thử đó ghi lỗi `<agent> produced no output for Ns`, rồi retry như timeout |
| 15 | Chi phí báo thiếu | Claude: cộng token từ `message.usage` của các event `assistant` (bỏ trùng theo `message.id`: input + cache creation + cache read + output). Token được báo cả với lần thử bị ngắt; UI hiện token của cả hai agent. Số $ vẫn chỉ có khi CLI báo |
| 16 | Diff chứa fence markdown | Fence của khối diff dài hơn chuỗi backtick dài nhất trong diff (tối thiểu 3) |
| 17 | Resume dùng config hiện tại | Xem §4 "Config gắn với run" |
| 18 | Lỗi gate cũ sau re-plan | Xem §5 |
| 19 | Buffer output không giới hạn | `runProcess` chỉ giữ 16 MB cuối của mỗi stream; callback theo dòng vẫn nhận đủ mọi dòng |
| 20 | `duo &` bị terminal dừng | Lúc khởi động, nếu stdout là TTY và tiến trình không ở foreground process group (so `pgid` với `tpgid` qua `ps -o pgid=,tpgid= -p <pid>`, chỉ trên POSIX), thì dùng renderer plain |
| 21 | Windows | Khi thoát, `killAllActive` dùng `taskkill` đồng bộ (`spawnSync`). Đối số của shim `.cmd` được quote cả `^`, `&`, `|`, `<`, `>`, `%`. Vẫn ghi là thử nghiệm |
| 22 | Raw mode kẹt sau SIGKILL | Không sửa được trong code. README mục Troubleshooting ghi cách gõ `reset` |
| 23 | Agent đọc secret · glob phân biệt hoa thường · config nới quyền read-only | Không còn áp dụng vì agentduo không còn quản quyền. README ghi rõ quyền là việc của từng CLI |
| 24 | `package.json` repository/homepage/bugs | Để trống (§2) |

## 7. `duo init`

- Viết `W/.agentduo/config.yaml` (không ghi đè nếu đã có) và `W/.agentduo/.gitignore` (`runs/`).
- Gate tự đoán được (như spec cũ) được ghi dưới dạng **comment**, kèm câu "uncomment to have agentduo run them after every implementation round".
- Nếu `W` không nằm trong git repo:
  - stdin là TTY: hỏi `This folder is not a git repository. Run 'git init' here? [y/N]`; trả lời `y` thì chạy `git init` trong `W`;
  - không phải TTY: in gợi ý `git init`.
  - Dù thế nào, config vẫn được viết.

## 8. Tài liệu

- **README.md và README.vi.md:**
  - Viết lại mục "Safety model" thành "Permissions and scope": agentduo không áp quyền, kèm ví dụ cấu hình Claude Code (`permissions.defaultMode`, allow rules) và Codex (`sandbox_mode`), cùng ví dụ `role_args`.
  - Thêm mô tả workspace.
  - Cập nhật Quick start (bỏ bước bắt buộc phải có gate), bảng lệnh (`--dir`, `--reload-config`, bỏ `--allow-dirty`), và bảng HUMAN_REVIEW (bỏ các lý do đã xoá).
  - Thêm mục Troubleshooting (`reset`, quyền bị từ chối, `duo -- "-x"`).
  - Ghi `--strict-mcp-config` là mẹo giảm chi phí.
- **AGENTS.md:** bỏ các gotcha về guard và câu về chained commands; thêm quy ước "agentduo không áp quyền, đừng thêm guard mới".

## 9. Kiểm thử

- Xoá các test chỉ dành cho guard và quyền: kịch bản e2e về readonly, guard, protected path, quyền theo vai trò, dirty worktree; các test config về permissions; test của `guards.ts`. `src/core/guards.ts` bị xoá.
- **Thêm:**
  - test lệnh gọi CLI: không có flag quyền, có `args`/`role_args`;
  - e2e workspace là thư mục con: diff chỉ gồm thay đổi trong `W`, cảnh báo ngoài workspace, `.agentduo` nằm trong `W`;
  - e2e cảnh báo bước chỉ đọc;
  - e2e không có gate: không có pha VERIFY, DONE khi Codex approve;
  - test cho từng mục ở §6.
- `smoke:real` dùng repo demo có `role_args.implementer: [--permission-mode, acceptEdits]` và một gate, vì máy chạy smoke không có sẵn settings quyền cho Claude.
