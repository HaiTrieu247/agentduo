# Multi-Agent Orchestrator: Codex lập kế hoạch/review, Claude Code implement

Hiện thực của [docs/codex_claude_multi_agent_plan.md](docs/codex_claude_multi_agent_plan.md). Một Python orchestrator (chỉ dùng stdlib) điều phối hai vòng lặp qua **Codex CLI** và **Claude Code CLI**:

1. **Planning & Debate:** Codex tạo plan → Claude phản biện → Codex sửa plan → … → Codex chốt plan cuối.
2. **Implementation & Review:** Claude implement → orchestrator tự chạy quality gates → Codex review diff và kết quả gates → Claude sửa → … → `DONE`.

Mọi phản hồi của agent đều là JSON, được kiểm tra theo schema. Khi vượt số vòng, khi vi phạm an toàn hoặc khi agent lỗi, run dừng ở `HUMAN_REVIEW` và chờ bạn quyết định.

## Yêu cầu

- Python ≥ 3.9 và git. Repo đích phải là git repository.
- [Codex CLI](https://developers.openai.com/codex/cli/): `npm install -g @openai/codex && codex login`
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference): nếu `claude` không có trong `PATH`, orchestrator tự tìm bản đi kèm extension VS Code (`~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude`). Cũng có thể đặt `claude.bin` trong config.

## Cài vào một dự án

```bash
cp -R .orchestrator /path/to/my-project/
cd /path/to/my-project
echo ".orchestrator/runs/" >> .gitignore
# Sửa .orchestrator/config.yaml: khai báo lệnh test/lint/typecheck của dự án trong `gates`
python3 .orchestrator/orchestrator.py --doctor
```

Không muốn copy thì có thể chạy từ chỗ khác: `python3 /path/to/.orchestrator/orchestrator.py --repo /path/to/my-project ...`. Config được tìm theo thứ tự: `--config`, rồi `<repo>/.orchestrator/config.yaml`, rồi config đi kèm script.

`--doctor` kiểm tra Python, git, config, schema, sự có mặt và các flag cần thiết của hai CLI, lệnh gate, trạng thái working tree, và việc `runs/` đã được git-ignore. Lệnh này không gọi agent nên không tốn chi phí.

## Sử dụng

```bash
# Tạo run mới (working tree phải sạch, hoặc thêm --allow-dirty)
python3 .orchestrator/orchestrator.py "Implement JWT authentication with refresh tokens"
python3 .orchestrator/orchestrator.py --task-file task.md

# Theo dõi
python3 .orchestrator/orchestrator.py --status [RUN_ID]
python3 .orchestrator/orchestrator.py --list

# Tiếp tục run bị ngắt (Ctrl-C, mất mạng…) từ pha cuối cùng chưa xong
python3 .orchestrator/orchestrator.py --resume [RUN_ID]

# Trả lời một run đang ở HUMAN_REVIEW
python3 .orchestrator/orchestrator.py --resume --decision resume --note "Chấp nhận C2, tiếp tục"
python3 .orchestrator/orchestrator.py --resume --decision revise --note "Bỏ phần cache, giữ API cũ"
python3 .orchestrator/orchestrator.py --resume --decision abort
```

Output mẫu (chạy với fake agents trong test):

```text
[01] PLAN r1          Codex   plan created: v1 'JWT auth' (6 steps, 5 acceptance criteria, 3 risks)
[02] PLAN_REVIEW r1   Claude  changes requested: 2 issue(s), 1 blocking
[03] PLAN r2          Codex   plan revised: v2 'JWT auth' (7 steps, 5 acceptance criteria, 4 risks)
[04] PLAN_REVIEW r2   Claude  approved: 0 issue(s), 0 blocking
[05] PLAN_FINALIZE r2 Codex   plan finalized: v2: ...
[06] IMPLEMENT r1     Claude  completed: 4 file(s) changed; ...
[07] VERIFY r1        gates   passed: tests PASS
[08] CODE_REVIEW r1   Codex   changes requested: 1 finding(s), 1 blocking
[09] IMPLEMENT r2     Claude  completed: 1 file(s) changed; ...
[10] VERIFY r2        gates   passed: tests PASS
[11] CODE_REVIEW r2   Codex   approved: 0 finding(s), 0 blocking
[DONE] quality gates passed and the review approved. Report: .orchestrator/runs/<id>/report.md
```

Orchestrator **không bao giờ commit hay push**. Thay đổi được để lại chưa commit trong working tree; bạn xem `report.md` và `git diff`, rồi tự commit.

Exit code: `0` DONE, `2` chờ HUMAN_REVIEW, `3` ABORTED, `1` lỗi cấu hình/môi trường, `130` bị ngắt.

## State machine

```text
PLAN → PLAN_REVIEW ─(approved)→ PLAN_FINALIZE ─(approved)→ IMPLEMENT → VERIFY → CODE_REVIEW → DONE
  ↑        │ changes requested       │ changes requested       ↑          │ gates fail      │ changes requested
  └────────┴─────────────────────────┘                         └──────────┴─────────────────┘
Mọi pha → HUMAN_REVIEW khi: vượt số vòng, guard vi phạm, agent lỗi/blocked, finding critical, gates fail liên tiếp
```

- `VERIFY` là pha orchestrator tự chạy `gates`. Khi gate required fail, run quay thẳng lại `IMPLEMENT` mà không tốn lượt review của Codex (`review_on_gate_failure: false`).
- Một plan/review chỉ được coi là **approved** khi `approved == true`, `status == "approved"`, và không còn issue nào thuộc `blocking_severities` (mặc định `critical`, `high`). Nếu `approved` và `status` mâu thuẫn, output bị coi là không hợp lệ và được retry.
- `DONE` cần cả ba điều kiện: Codex approve (`require_codex_approval`), mọi gate required đạt (`require_tests_pass`), và không còn finding blocking. Hai agent đồng ý với nhau thôi thì chưa đủ.

### Quyết định ở HUMAN_REVIEW

| Lý do (`reason`) | `--decision resume` làm gì |
|---|---|
| `max_planning_rounds` | Chấp nhận plan mới nhất làm plan cuối (ghi rõ là do người duyệt), rồi implement |
| `plan_ready` (khi `pause_before_implement: true`) | Bắt đầu implement |
| `max_review_rounds`, `critical_finding`, `gates_failing` | Mở vòng sửa mới và nới giới hạn số vòng |
| `implementer_blocked`, `dirty_worktree` | Chạy lại vòng implement hiện tại (thêm `--allow-dirty` nếu cần) |
| `guard_violation` | Chấp nhận thay đổi sau khi bạn đã kiểm tra, rồi chạy gates |
| `readonly_violation`, `agent_error`, `orchestrator_error` | Chạy lại đúng pha bị lỗi (với `readonly_violation`, hãy revert thay đổi trước) |

`revise` luôn quay về `PLAN` với `--note` làm feedback. `abort` kết thúc run. Mọi `--note` được đưa vào prompt của các lượt sau với độ ưu tiên cao nhất.

## Mô hình an toàn

Quyền được áp ở **mức công cụ**, không chỉ nằm trong prompt. Sau đó orchestrator còn **tự kiểm chứng** độc lập:

| Vai trò | Lệnh | Giới hạn ở mức CLI |
|---|---|---|
| Codex planner / reviewer | `codex exec --sandbox read-only --output-schema … -` | Sandbox read-only |
| Claude plan critic | `claude -p --tools Read,Grep,Glob --permission-mode dontAsk --permission-prompts none --json-schema …` | Chỉ có tool đọc |
| Claude implementer | `claude -p --permission-mode acceptEdits --permission-prompts none --allowedTools … --disallowedTools …` | Sửa file và chạy một số lệnh trong allowlist; `git commit/push/reset`, `rm -rf`, `curl` và WebFetch bị chặn; mọi thứ khác bị từ chối tự động |

Orchestrator tự kiểm chứng như sau:

- **Snapshot git cho mỗi vòng.** Toàn bộ working tree (kể cả file untracked) được ghi thành commit qua một index tạm. Index, HEAD và branch của bạn không bị đụng tới. Các commit này được ghim tại `refs/orchestrator/<run>/{base,impl-rN-pre,impl-rN}`, nên reviewer review đúng một git SHA (`reviewed_commit` phải khớp, nếu không thì retry), và bạn luôn khôi phục được trạng thái trước mỗi vòng.
- **Bước read-only** được hash tree trước và sau. Nếu có bất kỳ thay đổi nào, hoặc HEAD/branch bị dịch chuyển, run chuyển sang `readonly_violation`.
- **Sau khi implement**, orchestrator kiểm tra: HEAD/branch không đổi (Claude không được commit), không đụng `protected_paths` (`.env`, `*.pem`, `.github/workflows/**`, `.orchestrator/**`…), và số file bị xoá không vượt `max_deleted_files`.
- Mặc định orchestrator từ chối chạy khi working tree có thay đổi chưa commit, để không ghi đè lên việc dở dang của bạn.
- Giới hạn timeout cho mỗi agent và mỗi gate (kill cả process group), số lần retry, số vòng, số lần gates fail liên tiếp, và `claude.max_budget_usd` cho mỗi lần gọi.

## Cấu hình

Xem [.orchestrator/config.yaml](.orchestrator/config.yaml). Các khoá đều có giá trị mặc định trong [orch/config.py](.orchestrator/orch/config.py); khoá viết sai tên sẽ sinh cảnh báo. Config sai về mặt an toàn sẽ bị từ chối ngay từ đầu, ví dụ: implementer không phải Claude, reviewer có quyền ghi, hoặc `require_tests_pass: true` mà không khai báo gate nào.

PyYAML được dùng nếu đã cài. Nếu không, orchestrator dùng một parser YAML tối giản, hỗ trợ mapping, list, list of mapping, flow list, chuỗi có quote, số, bool và null.

## Artifacts của một run

Mỗi run nằm ở `.orchestrator/runs/<run-id>/`. Đây là cấu trúc trong mục 4 của kế hoạch, nhưng tách theo từng run để có thể resume và giữ lịch sử:

```text
state.json            trạng thái đầy đủ, ghi atomic sau mỗi bước (để resume)
events.jsonl          nhật ký sự kiện
plan.md               plan mới nhất · plan.vN.{json,md} từng phiên bản · plan.final.md bản đã chốt (kèm sha256)
plan-feedback.md      toàn bộ phản biện và quyết định chốt, theo vòng
critique.rN.json      phản biện của Claude    · approval.rN.json  quyết định chốt của Codex
implementation.rN.json báo cáo của Claude + danh sách file đổi + snapshot SHA + vi phạm guard
gates.rN.json, gates/ kết quả và log của quality gates
review.json           review mới nhất · review.rN.json từng vòng
report.md             báo cáo cuối: timeline, gates, diff stat, vấn đề chưa giải quyết, chi phí Claude
logs/NNN-<pha>-rN.aK.{prompt.md,cmd.json,stdout.txt,stderr.txt,output.json}   mỗi lần gọi CLI
```

Mỗi file JSON của agent được bọc trong một envelope gồm `task_id`, `role`, `agent`, `round`, `timestamp`, `git_sha`, `plan_version`, `attempts`, `duration_sec` và `cost_usd`, nhờ đó không review nhầm trạng thái cũ.

## Phát triển

```bash
python3 -m unittest discover -s tests
```

- `tests/test_units.py`: kiểm thử parser YAML, validate config, schema (gồm cả tương thích strict mode của OpenAI), guards, snapshot git, cách dựng lệnh và parse output của từng CLI.
- `tests/test_workflow.py`: chạy orchestrator đầy đủ qua subprocess thật, với `codex`/`claude` giả (`tests/fake_agent.py`) đọc kịch bản. Các kịch bản phủ: debate nhiều vòng; gates fail rồi sửa; review rồi sửa; vượt số vòng planning/review; `resume`/`revise`/`abort`; ghi file trong bước read-only; ghi `.env` và tự commit; output sai JSON/schema hoặc sai `reviewed_commit` được retry; finding critical; implementer blocked; `pause_before_implement`; working tree bẩn.

## Đối chiếu tiêu chí hoàn thành (mục 9 của kế hoạch)

| Tiêu chí | Cách đáp ứng |
|---|---|
| Plan có mục tiêu, phạm vi, acceptance criteria, rủi ro | `plan.schema.json`. `goals`, `scope_in`, `steps` và `acceptance_criteria` rỗng sẽ bị từ chối và retry |
| Claude phản biện plan trước khi implement | Pha `PLAN_REVIEW` là bắt buộc |
| Codex xác nhận plan cuối | Pha `PLAN_FINALIZE` (`require_plan_approval`) |
| Claude là agent duy nhất sửa code | Config bắt buộc implementer là Claude; reviewer chạy read-only ở mức CLI và tree được kiểm chứng bằng hash |
| Codex review diff và kết quả kiểm tra | Prompt review chứa diff `base..snapshot`, diff stat và kết quả gates |
| Claude xử lý findings, Codex review lại trên revision mới | `addressed_findings`, `resolved_findings`, mỗi vòng có snapshot SHA mới |
| Gates bắt buộc đạt, findings nghiêm trọng đã xử lý | Điều kiện `DONE`; finding `critical` → `HUMAN_REVIEW` |
| Không vượt số vòng; dừng và resume được | Giới hạn trong `limits`, `state.json`, `--resume`, `--decision` |
| Log, báo cáo cuối, vấn đề chưa giải quyết | `logs/`, `events.jsonl`, `report.md` |

## Chưa làm (Phase 3)

Đã có output tiến độ trên terminal, `--status` và `--list`. Phần MCP server hoặc extension VS Code riêng để quan sát, phê duyệt và resume chưa được xây; kế hoạch chỉ ghi phần này là "có thể thêm".

## Đã chạy thử với CLI thật

Repo thử là một module `calc.py` nhỏ, task: *"Add a subtract(a, b) function to calc.py, with a unit test"*. Dùng codex-cli 0.164.0 và Claude Code 2.1.311. Run đi qua 8 bước, từ `PLAN` đến `DONE`, hết khoảng 3 phút:

- Codex lập plan với 3 bước và 6 acceptance criteria. Claude approve, kèm 2 gợi ý không blocking. Codex chốt plan.
- Claude sửa 2 file, gate test pass, Codex review approve.
- Không có commit nào; diff để lại trong working tree.

Chi phí: Claude khoảng $0.33 cho 2 lần gọi, Codex khoảng 67k token cho 3 lần gọi.

## Chi phí

Mỗi vòng gồm vài lần gọi agent. Flag `--strict-mcp-config` (mặc định trong `claude.extra_args`) giảm đáng kể chi phí của Claude vì không nạp MCP server: khi thử, một lần gọi đơn giản giảm từ $0.44 xuống $0.075. Dùng `claude.model` / `codex.model` để chọn model rẻ hơn, và `claude.max_budget_usd` để chặn chi phí mỗi lần gọi. Dùng subscription không có nghĩa là API không giới hạn; xem mục 11 của kế hoạch.
