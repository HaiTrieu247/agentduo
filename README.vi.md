# agentduo (tiếng Việt)

Hai agent lập trình chạy chung một vòng lặp. **Codex** lập kế hoạch và review. **Claude Code** phản biện kế hoạch rồi implement. Bộ test của chính dự án đóng vai trọng tài. Giao diện terminal hiển thị live từng hành động của mỗi agent và những gì hai agent chuyển cho nhau.

## Cách hoạt động

1. **Lập kế hoạch và tranh luận.** Codex viết plan gồm mục tiêu, phạm vi, các bước, acceptance criteria và rủi ro. Claude kiểm tra xem plan có khả thi trong codebase của bạn không. Codex sửa plan cho đến khi Claude chấp thuận, rồi chốt bản cuối.
2. **Implement và review.** Claude implement theo plan. agentduo tự chạy các quality gate (test, lint, typecheck). Codex review diff cùng kết quả gate, Claude sửa theo các finding, lặp lại cho đến `DONE`.

Hai agent không nói chuyện trực tiếp với nhau. agentduo chuyển JSON đã kiểm tra theo schema giữa hai bên, và việc hai agent đồng ý với nhau không được tính là bằng chứng. `DONE` cần đủ cả ba điều kiện:
- Codex approve;
- mọi gate bắt buộc đều đạt;
- không còn finding nào ở mức blocking.

Khi vượt giới hạn, vi phạm quy tắc an toàn hoặc agent gặp lỗi, run dừng ở `HUMAN_REVIEW` và hỏi bạn.

## Yêu cầu và cài đặt

- Node.js ≥ 22.12 và git. Dự án phải là một git repository.
- Codex CLI (`npm i -g @openai/codex`, sau đó `codex login`) và Claude Code. Nếu Claude Code chỉ được cài qua extension VS Code, Cursor hoặc Windsurf, agentduo tự tìm binary đi kèm.

```bash
npm i -g agentduo
cd my-project
duo init      # tạo .agentduo/config.yaml với các gate tự đoán, thêm .agentduo/runs/ vào .gitignore
duo doctor    # kiểm tra môi trường, không gọi model
duo "Thêm xác thực JWT với refresh token"
```

`agentduo` là cùng một lệnh với `duo`. Hãy dùng `agentduo` nếu trên máy bạn đã có một công cụ khác tên là `duo`.

## Lệnh

| Lệnh | Tác dụng |
|---|---|
| `duo "<task>"` | Tạo run mới (`--task-file`, `--allow-dirty`) |
| `duo resume [id] [--decision resume\|revise\|abort --note "..."]` | Chạy tiếp, hoặc trả lời một quyết định đang chờ |
| `duo status`, `duo list` | Xem tiến độ |
| `duo doctor`, `duo init` | Kiểm tra môi trường, tạo config |

Giao diện:
- **Trong terminal:** giao diện live. Phím `v` bật/tắt chi tiết, `q` dừng sau bước hiện tại, `Ctrl-C` dừng ngay (run vẫn resume được).
- **Log dạng dòng:** dùng khi có `--plain`, khi `CI=true`, hoặc khi stdout không phải TTY.

agentduo không bao giờ commit hay push. Thay đổi được để lại trong working tree cho bạn review rồi tự commit.

## Khi run cần bạn quyết định

Trong terminal, agentduo hiện lý do kèm menu:
- Resume;
- Revise (kèm ghi chú);
- xem plan cuối, review gần nhất, phản biện plan hoặc diff stat;
- Abort;
- Để sau.

Ở chế độ plain, run thoát với exit code 2, và bạn trả lời bằng `duo resume --decision …`. Tác dụng của `resume` theo từng lý do được liệt kê trong [README.md](README.md#when-a-run-needs-you).

## An toàn

- **Quyền được áp ở mức CLI:**
  - Codex chạy `--sandbox read-only`.
  - Claude khi phản biện chỉ có các tool đọc.
  - Claude khi implement dùng allowlist/denylist (chặn commit, push, `rm -rf`, `curl`, truy cập web).
- **agentduo tự kiểm chứng thêm:**
  - Snapshot toàn bộ working tree vào `refs/agentduo/...` mà không đụng vào index, HEAD hay branch của bạn.
  - Hash working tree trước và sau mỗi bước read-only.
  - Chặn mọi commit của agent và mọi thay đổi trên `protected_paths`.
  - Giới hạn số file bị xoá.
  - Mặc định từ chối chạy khi working tree có thay đổi chưa commit.

## Exit code

| Code | Ý nghĩa |
|---|---|
| 0 | DONE |
| 1 | lỗi cấu hình hoặc môi trường |
| 2 | đang chờ bạn quyết định |
| 3 | đã huỷ |
| 130 | đã dừng (resume được) |

Hỗ trợ macOS và Linux. Windows ở mức thử nghiệm.
