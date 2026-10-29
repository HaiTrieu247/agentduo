# agentduo (tiếng Việt)

agentduo là kênh giao tiếp giữa hai agent lập trình. **Codex** lập kế hoạch và review. **Claude Code** phản biện kế hoạch rồi implement. agentduo chuyển các thông điệp có cấu trúc giữa hai bên, điều phối vòng lặp, và hiển thị live trên terminal từng hành động của mỗi agent cùng những gì hai agent chuyển cho nhau.

agentduo **không có luật riêng**. Quyền, sandbox và quy ước đều lấy từ config của từng CLI và từ `AGENTS.md`/`CLAUDE.md` của repo.

## Cài đặt và bắt đầu

```bash
npm i -g agentduo
cd my-project            # hoặc bất kỳ thư mục con nào: thư mục đó là workspace
duo init                 # tạo .agentduo/config.yaml (mọi mục đều tuỳ chọn) và .agentduo/.gitignore
duo doctor               # kiểm tra CLI và config, không gọi model
duo                      # mở chat
```

## Chat

Gõ `duo` (hoặc `agentduo`) mà không kèm task trong một terminal. Chat là cuộc trò chuyện ba người giữa bạn, Claude
Code và Codex; pipeline đầy đủ chỉ chạy khi bạn yêu cầu:

- **Gõ một tin** sẽ gửi cho agent ghi dưới ô nhập: Codex khi mới mở chat, sau đó là agent bạn chọn gần nhất.
  `/claude <câu hỏi>` và `/codex <câu hỏi>` hỏi thẳng một agent; `/claude` hoặc `/codex` đứng một mình thì chuyển người
  nhận cho các tin tiếp theo. Mỗi câu trả lời hiện đầy đủ, đúng một lần, kèm dấu nhà cung cấp (Anthropic / OpenAI) và
  model đã dùng. Cả hai agent đều thấy toàn bộ cuộc trò chuyện (tối đa 120.000 ký tự; các lượt cũ bị bỏ nguyên lượt và
  chat sẽ báo).
- **`/pipeline <yêu cầu>`** chạy cả workflow (plan → critique → finalize → implement → verify → review). Mọi vai trò
  đều được biết cuộc trò chuyện trước khi giao việc và các việc pipeline trước trong phiên chat đã làm gì.
- **`/discuss <câu hỏi>`** cho hai agent cùng đi tới một câu trả lời. Agent ghi dưới ô nhập trả lời, agent kia phản
  biện và kết thúc bằng `VERDICT: AGREE` hoặc `VERDICT: REVISE`, rồi agent thứ nhất sửa cho tới khi bên phản biện đồng
  ý, tối đa `limits.max_discussion_rounds` lần phản biện (mặc định 3; phản biện thiếu verdict tính là REVISE). Sau đó
  Codex, trong một lần gọi riêng, tổng hợp toàn bộ cuộc thảo luận thành câu trả lời cuối. Câu tổng hợp giữ những gì
  đứng vững từ cả hai agent, thêm các ý đúng trong phản biện mà phiên bản cuối còn thiếu, và bỏ những gì cuộc thảo luận
  đã chỉ ra là sai. Nếu lần phản biện cuối vẫn chưa đồng ý, câu trả lời kết bằng một mục ngắn "Còn bất đồng". Người
  tổng hợp luôn là Codex, nên khi Codex cũng là bên trả lời thì câu tổng hợp đến từ cùng một model, trong một lần gọi
  mới được yêu cầu giữ trung lập. Mỗi cuộc thảo luận tốn từ 3 đến 2N+1 lần gọi agent, với N là số lần phản biện tối đa.
  Mỗi lượt hiện ra khi xong (ở terminal là vài dòng đầu; `--verbose` hiện đầy đủ), rồi tới câu trả lời cuối, đầy đủ.
  Chỉ câu trả lời đó được đưa vào cuộc trò chuyện, như câu trả lời của Codex đã thảo luận với Claude. Nếu bước tổng hợp
  bị lỗi, agentduo báo một warning và câu trả lời là phiên bản gần nhất, ghi tên agent đã viết nó.
- **Gõ trong lúc pipeline đang chạy** thì tin đó thành ghi chú cho các bước kế tiếp. `/claude`, `/codex`,
  `/pipeline` và `/discuss` khi đó sẽ báo workspace đang bận; mỗi lúc chỉ có một lần gọi agent.
- **Esc** dừng việc đang chạy. Câu trả lời hay cuộc thảo luận bị dừng thì kết thúc ở đó, và không phần nào của nó được
  đưa vào cuộc trò chuyện. Bước pipeline bị dừng vẫn resume được:
  `/resume [ghi chú]` chạy lại bước đó (Enter trống chỉ nhắc `/resume`). `/pipeline` khi có run đang dừng sẽ tạo run
  mới; run cũ giữ ID và vẫn resume được. `/new` xóa cuộc trò chuyện và bắt đầu lại.
- **Model.** Ô nhập luôn hiện model của cả hai agent. Trước câu trả lời đầu tiên, agentduo tra cứu local mà không gọi
  model: Codex qua `codex doctor --json` (giữ các `-c`/`--enable`/`--disable`; doctor không nhận `--profile`, nên khi
  đó model hiện là chưa xác định kèm lý do), Claude qua `--model`, `ANTHROPIC_MODEL` và các file settings của Claude
  Code. Alias trong settings hiện là `default → sonnet (configured alias)` cho tới khi câu trả lời đầu tiên của Claude
  xác nhận tên model thật. Mỗi câu hỏi và mỗi run đều tra cứu lại, nên khi bạn sửa `~/.codex/config.toml` hoặc file
  settings của Claude thì model mới hiện từ lượt kế tiếp.
- **Gõ `/`** sẽ hiện danh sách lệnh kèm chú thích, lọc dần theo những gì bạn gõ: Up/Down để chọn, Tab hoặc Enter để
  điền, Enter lần nữa để gửi, Esc để đóng danh sách.
- **Prompt hỏi quyền và các quyết định** hiện ra thay cho ô nhập.
- **`/usage`** mở một popup thay cho ô nhập, giống `/usage` của Claude Code. Popup cho biết mỗi agent đã dùng bao nhiêu
  phần trăm hạn mức của gói, mỗi hạn mức có một thanh tiến độ và thời điểm reset. Bên dưới là phần "What's contributing
  to your limits usage?" của Claude. Cả hai đều không gọi model. Phía Claude là `claude -p /usage`. Phía Codex lấy từ
  `codex app-server` (`account/read` và `account/rateLimits/read`, giống cách extension IDE của Codex hỏi, kèm các
  `-c`/`--enable`/`--disable` của bạn), vì `/status` của Codex chỉ có trong giao diện TUI của nó. Popup hiện ngay, và
  phần của mỗi agent được điền khi agent đó trả lời (khoảng 2 giây, tối đa 15 giây). Bên nào lỗi thì chỉ phần của bên
  đó ghi lý do. ↑↓ để cuộn, `r` để lấy lại số liệu, Esc chỉ đóng popup, còn câu trả lời đang chạy vẫn chạy tiếp.
  `/status` giữ nguyên như cũ.
- **Đính kèm file.** `/attach <đường dẫn>` đính kèm một file thuộc bất kỳ loại nào (ảnh, PDF, text, code…) vào tin kế
  tiếp của bạn: câu hỏi, `/discuss`, task `/pipeline` hoặc ghi chú. Đường dẫn có dấu cách thì đặt trong nháy hoặc escape,
  theo cách shell đọc một từ: `/attach "~/Desktop/Ghi chú.pdf"`, `/attach shots/loi\ 2.png`. Dấu nháy đơn literal thì
  đặt trong nháy kép (`"it's.png"`); `'it''s'` được đọc thành `its`, giống shell. Đường dẫn tương đối tính từ workspace,
  `~/` tính từ thư mục home, dù có nằm trong nháy hay không (thư mục tên `~` thì viết `\~` hoặc `./~`); agentduo không
  glob hay mở rộng biến. `/attachments` liệt kê các file đang chờ, `/detach
  <n|all>` bỏ file. Enter trên dòng trống sẽ gửi riêng các file (cho agent ghi dưới ô nhập, hoặc thành ghi chú khi
  pipeline đang chạy). Terminal không đọc ảnh từ clipboard: hãy lưu ảnh ra file rồi `/attach`.
  - agentduo chép nguyên bytes của từng file vào `.agentduo/runs/conversations/<id>/attachments/` (file của task pipeline
    được chép vào `attachments/` của run, nên `/resume` không cần file gốc hay cuộc trò chuyện), và không bao giờ đưa vào
    snapshot. Giới hạn: 20 file, 20 MB mỗi file và 50 MB mỗi tin. File đang chờ gửi sẽ bị bỏ khi `/new` hoặc khi đóng
    chat; file đã gửi thì được giữ.
  - Mọi prompt đều liệt kê các file kèm đường dẫn bản sao, nên cả hai agent đọc được bằng tool của chính mình (agent có
    hiểu được một file nhị phân cụ thể hay không là tùy agent). Ảnh PNG, JPEG, GIF và WebP còn được gửi thẳng cho model
    dưới dạng ảnh: cho Claude là image block trong tin `stream-json`, cho Codex là `--image=<đường dẫn>`. Mỗi lần gọi,
    Claude nhận tối đa 20 ảnh, mỗi ảnh tối đa 8000 pixel mỗi cạnh và 5 MB sau khi mã hóa base64, tổng cộng 20 MB. Ảnh
    vượt các mức đó (hoặc ảnh agentduo không đọc được kích thước, hoặc SVG) chỉ được gửi dưới dạng đường dẫn, kèm warning.
  - Ảnh được gửi lại ở mọi lần gọi của `/discuss` và của pipeline (mỗi bước, mỗi lần retry hay repair là một lần gọi
    riêng), nên mỗi lần đều tốn thêm token và thời gian. Câu hỏi sau chỉ liệt kê đường dẫn file của tin trước.
  - Lúc cần quyết định HUMAN_REVIEW, file đang chờ không đi kèm quyết định: hãy gửi chúng trong một tin trước (thành ghi
    chú cho bước kế tiếp của run), hoặc chọn quyết định sau rồi `/resume` kèm ghi chú.
- **Lệnh:** `/claude`, `/codex`, `/pipeline`, `/discuss`, `/plan`, `/diff`, `/status`, `/usage`, `/attach`,
  `/attachments`, `/detach`, `/resume` (chạy tiếp run đang dừng hoặc đang chờ, kể cả từ phiên trước), `/new`,
  `/settings`, `/config`, `/help`, `/quit`. Bấm Ctrl-C hai lần cũng thoát; run đang chạy sẽ dừng ở bước hiện tại và vẫn
  resume được.

**Đổi cấu hình ngay trong chat.** Cú pháp chuẩn là `/settings claude …` và `/settings codex …`; sai cú pháp thì
agentduo trả về usage. `/claude model …` và các lệnh tương tự là lối tắt, chỉ được hiểu là cấu hình khi đúng hình dạng
(`/claude model opus`); còn lại, ví dụ `/claude model nào phù hợp nhất cho repo này?`, được gửi nguyên văn cho Claude
như một câu hỏi, kể cả `--save`. `/claude -- <câu hỏi>` luôn là câu hỏi.
- Shift+Tab hoặc `/edits auto|ask`: Claude tự sửa file mà không hỏi (`acceptEdits`), cả trong chat lẫn khi làm implementer của pipeline, hoặc hỏi trước khi sửa.
- `/claude model …`, `/claude effort …`, `/claude permissions allow|deny|remove <rule>`, `/claude add-dir <path>`.
- `/codex model <tên> [effort]`, `/codex permissions read-only|auto|full-access|default`. Riêng `full-access` phải xác nhận thêm bằng `--yes`.
- `/config` để xem cấu hình mà hai agent đang chạy.

Thay đổi áp dụng từ câu hỏi hoặc lần gọi agent kế tiếp; câu trả lời đang chạy giữ model lúc nó bắt đầu. Thay đổi chỉ giữ trong phiên chat, trừ khi lệnh kết thúc bằng `--save`: khi đó agentduo ghi vào `.agentduo/config.yaml` và giữ nguyên các comment trong file. `/help` liệt kê mọi lệnh kèm giải thích. Ngoài chat, `duo --accept-edits "<task>"` có tác dụng giống `/edits auto`.

`duo "<task>"` và `duo run "<task>"` vẫn chạy pipeline cho một việc rồi thoát; đây là cách dùng cho script và CI.

## Extension VS Code

`extensions/vscode` đưa chat này vào sidebar của VS Code. Sidebar có timeline của hai agent, phần trả lời HUMAN_REVIEW và quyền của Claude ngay trên ô nhập, cùng các nút mở plan, review, report và xem thay đổi của run bằng diff editor. Extension chạy engine của agentduo bằng Node của bạn (≥ 22.12). Nó dùng chung cấu hình, thư mục run và lock với `duo`, nên run bắt đầu ở bên này có thể tiếp tục ở bên kia.

Extension có trên Marketplace (`HaiTrieuThinh.agentduo-vscode`). Để cài bản build tại máy:

```sh
npm ci
npm run package:vscode
code --install-extension extensions/vscode/agentduo-vscode-*.vsix
```

Không cần cài gói npm `agentduo`. Máy chỉ cần Node, git, Codex CLI và Claude Code đã đăng nhập. Nếu VS Code mở từ Dock không thấy đúng `PATH`, đặt `agentduo.nodePath` trong settings của VS Code, hoặc `codex.bin` / `claude.bin` trong `.agentduo/config.yaml`.

- Mở sidebar không chạy gì cả. Run chỉ bắt đầu khi bạn gửi task. Với workspace nhiều thư mục, bạn chọn thư mục trước (**agentduo: Choose Workspace Folder**).
- Enter để gửi, Shift+Enter để xuống dòng. Khi agent đang chạy, nội dung bạn gửi là ghi chú cho bước kế tiếp. **Stop** (hoặc Esc trong ô nhập) dừng bước hiện tại; gửi lại sẽ chạy lại bước đó. Các lệnh `/new`, `/resume`, `/edits`, `/claude …`, `/codex …` giống hệt trong terminal.
- **Đính kèm file:** nút kẹp giấy dưới ô nhập chọn được nhiều file bất kỳ. Bạn cũng có thể dán ảnh (Cmd/Ctrl+V), hoặc **giữ Shift** khi kéo file từ Finder/Explorer của hệ điều hành vào ô nhập (VS Code cần Shift mới cho webview nhận file thả vào). Kéo từ Explorer của chính VS Code hay từ editor thì tab không đọc được file, nên hãy dùng nút kẹp giấy. File chờ hiện phía trên ô nhập (ảnh có thumbnail), có ✕ để bỏ; gửi với ô nhập trống thì chỉ gửi file. File chờ gửi bị bỏ khi `/new` hoặc khi đóng tab. Giới hạn và cách gửi ảnh giống chat trên terminal.
- Reload cửa sổ hay đóng VS Code sẽ dừng bước đang chạy. Quyết định đang chờ được hoãn, yêu cầu quyền chưa trả lời bị từ chối, và run vẫn tiếp tục được. Extension không bao giờ tự chạy lại task; nó hiện nút **Resume** để bạn bấm.
- Bản đầu chỉ hỗ trợ VS Code desktop với thư mục local. Chưa hỗ trợ Remote SSH, WSL, container hay VS Code web.

Chi tiết xem [extensions/vscode/README.md](../extensions/vscode/README.md). Khi phát triển, mở repo trong VS Code rồi nhấn F5 (**Run agentduo extension**).

Yêu cầu: Node.js ≥ 22.12, git, Codex CLI và Claude Code. Workspace phải nằm trong một git repo. Nếu chưa có, `duo init` sẽ hỏi có muốn `git init` không.

## Workspace

`duo` làm việc ở thư mục bạn gọi nó, hoặc ở `--dir PATH`:
- hai agent chạy ở đó;
- `.agentduo/` nằm ở đó;
- diff gửi cho reviewer chỉ gồm thay đổi trong thư mục đó.

Nếu agent sửa file ngoài workspace (trong cùng repo), agentduo cảnh báo trên màn hình và trong report, với đường dẫn tính từ workspace (`../shared/x.ts`), nhưng không dừng run.

Thư mục runs có `.gitignore` riêng, nên dữ liệu run không lọt vào `git status` hay commit, kể cả khi bạn chưa chạy `duo init`.

## Quyền

agentduo chỉ truyền các flag giao thức, và không flag nào cấp quyền.

**Khi Claude xin quyền, agentduo hỏi bạn.** Nếu Claude cần một tool mà settings chưa cho phép, run tạm dừng và hiện đúng câu hỏi của Claude:
- **Cho lần này**.
- **Luôn cho**: Claude tự lưu rule nó đề xuất vào `.claude/settings.local.json`, giống như khi bạn trả lời Claude trực tiếp. File này không bao giờ nằm trong snapshot hay trong diff gửi reviewer.
- **Từ chối**, hoặc **từ chối kèm lời nhắn** cho Claude.

Trong lúc chờ bạn trả lời, timeout của agent tạm dừng. Ở chế độ `--plain` trong terminal, các lựa chọn hiện dưới dạng một câu hỏi một dòng.

Khi không ai trả lời được (CI, chạy nền, output bị chuyển hướng), Claude chạy với `--permission-prompts none` và tự từ chối. Đặt `claude.permission_prompts: deny` nếu muốn luôn tự từ chối như vậy.

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
| `duo` | Mở [chat](#chat) (trong terminal) |
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

- **Tool bị từ chối:** khi chạy trong terminal, Claude sẽ hỏi bạn trước (xem phần [Quyền](#quyền)). Run không có người trông thì cần cấp quyền từ trước; cảnh báo sẽ ghi tên các tool bị từ chối.
  - Sửa file (`Edit`, `Write`): đặt `permissions.defaultMode` thành `"acceptEdits"` trong settings của Claude Code, hoặc thêm `claude.role_args.implementer: [--permission-mode, acceptEdits]`.
  - Chạy lệnh (`Bash`): thêm allow rule, ví dụ `"Bash(npm test:*)"`.
  - Nếu Codex làm implementer, xem mục **Codex** ở phần [Quyền](#quyền).
- **Sửa `config.yaml` rồi `duo resume` mà không có tác dụng:** run giữ config lúc nó bắt đầu. Dùng `duo resume --reload-config` để áp dụng config mới. Thay đổi trong settings của Claude Code hay Codex thì không cần lệnh này.
- **Task bắt đầu bằng `-`** bị hiểu nhầm là option. Đặt `--` trước nó: `duo -- "-x bị lỗi"`.
- **Terminal hiển thị lạ sau khi agentduo bị `kill -9`:** gõ `reset`.
- **Giảm chi phí:** đặt `claude.args: [--strict-mcp-config, --no-session-persistence]` để agentduo không nạp các MCP server của bạn.
- **Windows** ở mức thử nghiệm.
