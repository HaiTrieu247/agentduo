# agentduo (tiếng Việt)

agentduo là kênh giao tiếp giữa hai agent lập trình. **Codex** lập kế hoạch và review. **Claude Code** phản biện kế hoạch rồi implement. agentduo chuyển các thông điệp có cấu trúc giữa hai bên, điều phối vòng lặp, và hiển thị live trên terminal từng hành động của mỗi agent cùng những gì hai agent chuyển cho nhau.

agentduo **không có luật riêng**. Quyền, sandbox và quy ước đều lấy từ config của từng CLI và từ `AGENTS.md`/`CLAUDE.md` của repo.

## Cài đặt và bắt đầu

```bash
npm i -g agentduo
cd my-project            # hoặc bất kỳ thư mục con nào: thư mục đó là workspace
duo init                 # tạo .agentduo/config.yaml (mọi mục đều tuỳ chọn) và .agentduo/.gitignore
duo doctor               # kiểm tra CLI và config, không gọi model
duo "Thêm xác thực JWT với refresh token"
```

Yêu cầu: Node.js ≥ 22.12, git, Codex CLI và Claude Code. Workspace phải nằm trong một git repo. Nếu chưa có, `duo init` sẽ hỏi có muốn `git init` không.

## Workspace

`duo` làm việc ở thư mục bạn gọi nó, hoặc ở `--dir PATH`:
- hai agent chạy ở đó;
- `.agentduo/` nằm ở đó;
- diff gửi cho reviewer chỉ gồm thay đổi trong thư mục đó.

Nếu agent sửa file ngoài workspace (trong cùng repo), agentduo cảnh báo trên màn hình và trong report, với đường dẫn tính từ workspace (`../shared/x.ts`), nhưng không dừng run.

Thư mục runs có `.gitignore` riêng, nên dữ liệu run không lọt vào `git status` hay commit, kể cả khi bạn chưa chạy `duo init`.

## Quyền

agentduo chỉ truyền các flag giao thức. Với Claude, nó có thêm `--permission-prompts none`, flag này không cấp quyền gì.

- **Claude Code** lấy quyền từ settings của bạn. Khi chạy không tương tác, Claude chỉ dùng được tool mà settings cho phép:
  - `"permissions": { "defaultMode": "acceptEdits" }` cho phép sửa file, nhưng không cho chạy lệnh;
  - muốn chạy lệnh thì thêm allow rule, ví dụ `"permissions": { "allow": ["Bash(npm test:*)"] }`. Khi không có gate, implementer tự chạy test của dự án, nên hãy cho phép các lệnh đó.

  Lần gọi tool nào bị từ chối sẽ hiện `⊘ denied`, kèm một cảnh báo ghi rõ tên tool.
- **Codex** lấy quyền từ `~/.codex/config.toml`. Theo mặc định `codex exec` chỉ được đọc. Nếu Codex làm implementer, nó cần `sandbox_mode = "workspace-write"` hoặc `codex.role_args.implementer: [--sandbox, workspace-write]`.
- **Muốn đặt riêng cho từng vai trò** khi chạy qua agentduo, dùng `role_args`:

```yaml
claude:
  role_args:
    implementer: [--permission-mode, acceptEdits]
codex:
  role_args:
    code_reviewer: [--sandbox, read-only]
```

agentduo không chặn gì. Nó chỉ cảnh báo khi agent lập kế hoạch hoặc review sửa file, và khi có file ngoài workspace bị sửa. agentduo không bao giờ commit hay push.

## Lệnh

| Lệnh | Tác dụng |
|---|---|
| `duo "<task>"` | Tạo run mới (`--task-file`; task bắt đầu bằng `-` thì gõ `duo -- "-x …"`) |
| `duo resume [id]` | Chạy tiếp với config lúc run bắt đầu (thêm `--reload-config` để dùng config hiện tại); `--decision resume\|revise\|abort [--note "..."]` để trả lời quyết định đang chờ |
| `duo status`, `duo list` | Xem tiến độ |
| `duo doctor`, `duo init` | Kiểm tra môi trường, tạo config |

Giao diện:
- **Trong terminal:** giao diện live. Phím `v` bật/tắt chi tiết, `q` dừng sau bước hiện tại, `Ctrl-C` dừng ngay. Tại menu quyết định, `Ctrl-C` nghĩa là "Để sau".
- **Log dạng dòng:** khi có `--plain`, khi chạy trong CI, khi stdout không phải TTY, hoặc khi chạy nền (`duo … &`).

Mọi lệnh đều nhận `--dir`, `--config`, `--plain`, `-v` và `--no-color`, đặt trước hay sau tên lệnh đều được.

## Gộp config

Thứ tự gộp là: mặc định, rồi `~/.config/agentduo/config.yaml`, rồi `.agentduo/config.yaml` của workspace (hoặc `--config`). Nguồn sau thắng nguồn trước.
- **Mapping** được gộp theo từng khoá, và `role_args` được gộp theo từng vai trò.
- **List** (`args`, `gates`, `blocking_severities`) thay hẳn giá trị trước. Ví dụ, `claude.args: [--strict-mcp-config]` sẽ bỏ mất `--no-session-persistence` mặc định nếu bạn không ghi lại nó.

## Quality gates

Gate là tuỳ chọn. Mặc định không có gate: Claude tự chạy test theo config của nó, và run DONE khi Codex approve. Nếu bạn khai báo `gates`, agentduo chạy chúng sau mỗi vòng implement và chuyển kết quả cho Codex. `duo init` gợi ý sẵn các gate tìm được, dưới dạng comment.

## Exit code

| Code | Ý nghĩa |
|---|---|
| 0 | DONE |
| 1 | lỗi cấu hình hoặc môi trường |
| 2 | đang chờ bạn quyết định |
| 3 | đã huỷ |
| 130 | đã dừng (resume được) |

## Xử lý sự cố

- **Tool bị từ chối:** cảnh báo sẽ ghi tên tool.
  - Sửa file (`Edit`, `Write`): đặt `permissions.defaultMode` thành `"acceptEdits"` trong settings của Claude Code, hoặc thêm `claude.role_args.implementer: [--permission-mode, acceptEdits]`.
  - Chạy lệnh (`Bash`): thêm allow rule, ví dụ `"Bash(npm test:*)"`.
  - Nếu Codex làm implementer, xem mục **Codex** ở phần [Quyền](#quyền).
- **Sửa `config.yaml` rồi `duo resume` mà không có tác dụng:** run giữ config lúc nó bắt đầu. Dùng `duo resume --reload-config` để áp dụng config mới. Thay đổi trong settings của Claude Code hay Codex thì không cần lệnh này.
- **Task bắt đầu bằng `-`** bị hiểu nhầm là option. Đặt `--` trước nó: `duo -- "-x bị lỗi"`.
- **Terminal hiển thị lạ sau khi agentduo bị `kill -9`:** gõ `reset`.
- **Giảm chi phí:** đặt `claude.args: [--strict-mcp-config, --no-session-persistence]` để agentduo không nạp các MCP server của bạn.
- **Windows** ở mức thử nghiệm.
