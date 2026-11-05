import { flowFigure } from "../../../lib/figures.mjs";

export const FLOW = {
  label: "Pipeline với các vai trò mặc định. Vai trò của mỗi agent có thể đổi trong cấu hình.",
  plan: { title: "Lập kế hoạch và thống nhất", back: "yêu cầu thay đổi: quay lại Plan" },
  build: { title: "Triển khai và review", back: "có phát hiện: quay lại Implement" },
  steps: [["Plan", "Codex"], ["Critique", "Claude Code"], ["Finalize", "Codex"], ["Implement", "Claude Code"], ["Verify", "gate của bạn"], ["Review", "Codex"]],
  handoff: "kế hoạch cuối cùng được chuyển cho bên triển khai",
  done: "Được duyệt, không còn phát hiện chặn, các gate bắt buộc đạt: xong. Bạn review và commit.",
  legend: ["Codex", "Claude Code", "lệnh của bạn (tùy chọn)"],
  motion: ["Tạm dừng hiệu ứng", "Chạy hiệu ứng"],
};

export default ({ c, link, btn, code, table }, d) => ({
  htmlTitle: "AgentDuo: Codex và Claude Code kiểm tra công việc của nhau",
  title: "Để Codex và Claude Code kiểm tra công việc của nhau",
  description: "AgentDuo kết nối Codex và Claude Code: một bên lập kế hoạch và review, bên kia phản biện và triển khai. Có ứng dụng desktop, lệnh terminal và tiện ích VS Code.",
  lead: `<div class="lead"><p>AgentDuo kết nối hai CLI lập trình mà bạn vốn đang dùng. Codex viết kế hoạch và review diff; Claude Code phản biện kế hoạch rồi triển khai. Bạn thấy mọi lần bàn giao và đưa ra những quyết định cần đến con người.</p></div>`,
  actions: `<div class="actions">${btn("download", d.release ? `Tải AgentDuo ${d.release.version}` : "Tải về", true)}${btn("learn", "Bắt đầu")}</div>
<p class="hero-meta">Ứng dụng desktop cho macOS, Windows và Linux, lệnh ${c("duo")} cho terminal, và tiện ích VS Code. Miễn phí và mã nguồn mở; bạn tự dùng tài khoản Claude Code và Codex của mình.</p>`,
  visual: flowFigure(FLOW),
  sections: [
    {
      id: "why",
      title: "Hai agent mang lại những gì một agent không có",
      html: `<ul class="benefits">
<li><strong>Có kế hoạch trước khi viết mã</strong>Codex viết mục tiêu, phạm vi, các bước, tiêu chí chấp nhận và rủi ro. Claude Code kiểm tra kế hoạch có làm được không trước khi bất kỳ tệp nào bị thay đổi, và Codex duyệt phiên bản cuối.</li>
<li><strong>Người đọc thứ hai cho mọi diff</strong>Bên review nhận diff thật của workspace giữa các snapshot, không phải bản tóm tắt của bên triển khai, và báo các phát hiện theo mức độ nghiêm trọng.</li>
<li><strong>Kiểm tra của bạn, không phải lời của agent</strong>Thêm lệnh của riêng bạn làm gate (${c("npm test")}, một linter). Chúng chạy sau mỗi vòng triển khai và kết quả được gửi cho bên review.</li>
<li><strong>Bạn quyết định những gì cần con người quyết định</strong>Khi đạt giới hạn số vòng, một agent bị chặn, hoặc có phát hiện nghiêm trọng, lượt chạy sẽ dừng và hỏi bạn: tiếp tục, sửa lại kèm ghi chú, hoặc hủy.</li>
<li><strong>Không có quy tắc mới để phải tin</strong>AgentDuo chỉ truyền các cờ mà giao thức của nó cần. Mỗi agent được phép làm gì là do cài đặt CLI của chính nó và ${c("AGENTS.md")} hoặc ${c("CLAUDE.md")} trong repository của bạn.</li>
<li><strong>Không có gì được commit thay bạn</strong>Các thay đổi nằm lại trong working tree. Xem lại bằng ${c("git diff")} hoặc màn hình diff, rồi tự commit.</li>
</ul>`,
    },
    {
      id: "how-they-work-together",
      title: "Hai agent phối hợp như thế nào",
      html: `<p class="band-lead">Một lượt chạy pipeline có hai giai đoạn. Ở giai đoạn đầu, các agent thống nhất kế hoạch; ở giai đoạn hai, một bên triển khai và bên kia review cho đến khi bản review duyệt.</p>
<div class="split">
<div>
<p><strong>Lập kế hoạch và thống nhất.</strong> Codex (người lập kế hoạch) viết kế hoạch. Claude Code (người phản biện kế hoạch) đối chiếu với repository rồi duyệt hoặc yêu cầu thay đổi. Codex sửa lại và, khi bên phản biện duyệt, chốt kế hoạch. Nếu không thống nhất được trong ${c("limits.max_planning_rounds")} vòng (mặc định 4), lượt chạy sẽ hỏi bạn.</p>
</div>
<div>
<p><strong>Triển khai và review.</strong> Claude Code (người triển khai) xây dựng theo kế hoạch cuối. Các gate của bạn chạy, nếu bạn có cấu hình. Codex (người review mã) review diff; Claude Code sửa các phát hiện, hết vòng này đến vòng khác, tối đa ${c("limits.max_review_rounds")} vòng (mặc định 5).</p>
</div>
</div>
<p>Mỗi agent là một tiến trình CLI thật với cài đặt của bạn, do AgentDuo chạy trong workspace của bạn. CLI nào đóng vai nào là tùy chỉnh được: bạn có thể cho Codex triển khai và Claude Code review. ${link("docs/concepts", "Đọc cách AgentDuo hoạt động")}.</p>`,
    },
    {
      id: "interfaces",
      className: "band-wide",
      title: "Ba cách chạy, một engine",
      html: `<p class="band-lead">Ứng dụng desktop, lệnh terminal và tiện ích VS Code chạy cùng một engine, đọc cùng các tệp cấu hình và lưu các lượt chạy trong cùng một thư mục, nên lượt chạy dừng ở nơi này có thể tiếp tục ở nơi khác.</p>
<div class="interfaces">
<div class="interface"><h3>Ứng dụng desktop</h3><p>Một cửa sổ với các dự án và hội thoại của bạn, cuộc trò chuyện ba bên, bảng kiểm tra cho kế hoạch, diff và các lần kiểm tra, cùng Settings. Trò chuyện mà không cần mở thư mục; mở một dự án khi bạn muốn làm việc với mã.</p><p class="needs">Cần cài Claude Code và Codex và đã đăng nhập. Không cần cài Node riêng.</p><p>${link("learn/desktop", "Bắt đầu với ứng dụng desktop")}</p></div>
<div class="interface"><h3>Terminal: ${c("duo")}</h3><p>Cuộc trò chuyện ngay trong terminal với màn hình trực tiếp của cả hai agent, cùng các lệnh cho script và CI: ${c('duo "<task>"')}, ${c("duo resume")}, ${c("duo status")}.</p><p class="needs">Cần Node.js 22.12 trở lên: ${c("npm i -g agentduo")}.</p><p>${link("learn/cli", "Bắt đầu trong terminal")}</p></div>
<div class="interface"><h3>Tiện ích VS Code</h3><p>Mỗi hội thoại nằm trong một tab của trình soạn thảo, quyết định và yêu cầu cấp quyền hiện phía trên ô soạn tin, và các thay đổi của lượt chạy xem trong trình soạn diff của VS Code.</p><p class="needs">Cần VS Code 1.95 trở lên và Node.js 22.12 trở lên.</p><p>${link("learn/vscode", "Bắt đầu trong VS Code")}</p></div>
</div>`,
    },
    {
      id: "example",
      className: "band-wide",
      title: "Một phiên làm việc trông như thế nào",
      html: `<p class="band-lead">Hỏi một trong hai agent một câu, để cả hai thảo luận, rồi giao tác vụ cho pipeline. Đây là cuộc trò chuyện trong terminal; ứng dụng desktop và tiện ích hiển thị cùng một hội thoại.</p>
<div class="split">
<div>
${code(`› /claude What would it take to add refresh tokens here?
  … Claude Code answers, with the whole conversation in context …
› Is that plan safe for the existing sessions?
  … Codex answers, with Claude's answer in its context …
› /discuss Should refresh tokens rotate on every use?
  … one answers, the other reviews until they agree; Codex sums up …
› /pipeline Add refresh tokens as discussed
  … Codex plans, Claude critiques, Claude implements, Codex reviews …`, { label: "duo" })}
</div>
<div>
${code(`● PLAN r1  Codex (planner)                      32s · 33k tok
  └ Codex → Claude  Plan v1 "Add subtraction" · 3 steps
● PLAN_REVIEW r1  Claude (plan critic)          48s · $0.17
  └ Claude → Codex  approved · 2 suggestion(s)
 PLAN ✓ › CRITIQUE ✓ › FINALIZE ✓ › IMPLEMENT ● r1 › VERIFY › REVIEW`, { label: "Màn hình trực tiếp của một lượt chạy (từ README của repository)" })}
<p>Tin nhắn được gửi đến agent có tên dưới ô nhập. ${c("/claude")} và ${c("/codex")} chọn ai trả lời, ${c("/discuss")} để cả hai cùng đưa ra một câu trả lời, và ${c("/pipeline")} chạy toàn bộ quy trình. ${link("docs/conversations", "Tìm hiểu cuộc trò chuyện")}.</p>
</div>
</div>`,
    },
    {
      id: "before-you-start",
      title: "Trước khi bắt đầu",
      html: `${table({
        caption: "AgentDuo cần những gì",
        head: ["Bạn cần", "Vì sao"],
        rows: [
          ["Claude Code CLI, đã đăng nhập", "Claude Code là một trong hai agent. AgentDuo chạy CLI bạn đã cài bằng tài khoản của bạn."],
          ["Codex CLI, đã đăng nhập", "Codex là agent còn lại, cũng được chạy như CLI bạn đã cài bằng tài khoản của bạn."],
          ["Một gói Claude và một gói OpenAI hoặc quyền truy cập API", "AgentDuo không kèm gói đăng ký hay tín dụng API. Mức dùng của mỗi agent được tính vào gói hoặc khóa của chính bạn."],
          ["Git, cho pipeline", "Một lượt chạy pipeline snapshot và so sánh diff các tệp của bạn, nên workspace phải nằm trong một repository Git. Trò chuyện và thảo luận chạy được ở mọi thư mục."],
          ["Node.js 22.12 trở lên, cho terminal và VS Code", "Ứng dụng desktop tự mang runtime cho engine; gói npm và tiện ích dùng Node của bạn."],
        ],
      })}
<div class="actions">${btn("learn/prerequisites", "Kiểm tra bạn cần gì", true)}${btn("download", "Xem mọi bản tải")}</div>`,
    },
  ],
});
