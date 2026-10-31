export default ({ c, link, code, p, ul, table, note }) => ({
  title: "Tệp và hình ảnh",
  description: "Đính kèm tệp và hình ảnh vào tin nhắn AgentDuo: cách làm ở từng giao diện, cách đặt dấu ngoặc cho đường dẫn, giới hạn, nơi lưu bản sao, và những gì Claude Code và Codex nhận được.",
  lead: p("Bạn có thể đính kèm mọi loại tệp (hình ảnh, PDF, văn bản, code) vào tin nhắn, câu hỏi, " + c("/discuss") + ", tác vụ " + c("/pipeline") + " hoặc ghi chú tiếp theo của mình. AgentDuo sao chép từng tệp và cho cả hai agent biết bản sao ở đâu."),
  sections: [
    {
      id: "how",
      title: "Đính kèm",
      html: `${table({
  caption: "Cách đính kèm tệp ở từng giao diện",
  head: ["Giao diện", "Cách làm"],
  rows: [
    ["Ứng dụng desktop", "Nút đính kèm, dán một hình ảnh, hoặc thả tệp lên ô soạn tin."],
    ["VS Code", "Biểu tượng kẹp giấy, dán một hình ảnh (Cmd/Ctrl+V), hoặc giữ Shift trong khi kéo tệp từ Finder hoặc Explorer vào ô soạn tin. Kéo từ Explorer của chính VS Code không mang theo tệp nào: hãy dùng biểu tượng kẹp giấy."],
    ["Terminal", c("/attach <path>") + " cho từng tệp; " + c("/attachments") + " liệt kê các tệp đang chờ và " + c("/detach <n|all>") + " gỡ chúng. Terminal không đọc hình ảnh từ clipboard: hãy lưu hình ảnh rồi đính kèm."],
  ],
})}
${p("Các tệp chờ cho đến khi bạn gửi chúng cùng tin nhắn tiếp theo. Gửi với ô nhập trống sẽ chỉ gửi các tệp (đến agent có tên dưới ô nhập, hoặc dưới dạng ghi chú khi một pipeline đang chạy).")}`,
    },
    {
      id: "paths",
      title: "Đường dẫn trong /attach",
      html: `${p("Terminal đọc đường dẫn theo cách một shell đọc một từ:")}
${code(`/attach notes.md
/attach "~/Desktop/My notes.pdf"
/attach shots/bug\\ 2.png
/attach "it's.png"`, { label: "duo" })}
${ul([
  `Đường dẫn tương đối bắt đầu từ workspace; ${c("~/")} bắt đầu từ thư mục home của bạn, có hoặc không có dấu ngoặc. Viết ${c("\\~")} hoặc ${c("./~")} cho thư mục tên là ${c("~")}. Không có gì bị glob hay mở rộng.`,
  `Một dấu ${c("'")} nguyên văn đặt trong dấu ngoặc kép; ${c("'it''s'")} được đọc là ${c("its")}, như trong shell.`,
  `Trên Windows, dấu gạch chéo ngược phân tách thư mục và không escape gì cả, nên đường dẫn có khoảng trắng phải đặt trong dấu ngoặc (${c('/attach "C:\\Users\\me\\My notes.pdf"')}), và ${c("~\\")} cũng là thư mục home của bạn.`,
])}`,
    },
    {
      id: "limits",
      title: "Giới hạn",
      html: `${table({
  caption: "Giới hạn đính kèm",
  head: ["Giới hạn", "Giá trị"],
  rows: [
    ["Số tệp mỗi tin nhắn", "20"],
    ["Kích thước một tệp", "20 MB"],
    ["Tổng các tệp của một tin nhắn", "50 MB"],
    ["Hình ảnh gửi cho Claude dưới dạng hình ảnh, mỗi lời gọi", "20, mỗi ảnh tối đa 8000 pixel mỗi cạnh và 5 MB sau khi mã hóa base64, tổng cộng 20 MB"],
    ["Hình ảnh gửi cho Codex dưới dạng hình ảnh, mỗi lời gọi", "20"],
  ],
})}`,
    },
    {
      id: "what-agents-get",
      title: "Các agent nhận được gì",
      html: `${ul([
  "Mỗi prompt liệt kê các tệp đính kèm cùng đường dẫn của bản sao, nên cả hai agent có thể đọc chúng bằng công cụ của riêng mình. Agent có hiểu được một tệp nhị phân cụ thể hay không là tùy ở nó.",
  `Hình ảnh PNG, JPEG, GIF và WebP cũng được gửi cho model dưới dạng hình ảnh: cho Claude dưới dạng khối hình ảnh của một tin nhắn ${c("stream-json")}, cho Codex bằng ${c("--image=<path>")}.`,
  "Một hình ảnh vượt giới hạn của Claude, một hình ảnh mà AgentDuo không đọc được kích thước, hoặc một tệp SVG chỉ được gửi dưới dạng đường dẫn, và một cảnh báo sẽ nói rõ điều đó.",
  "Một câu hỏi sau đó chỉ liệt kê các tệp của tin nhắn trước theo đường dẫn; hình ảnh không được gửi lại.",
])}`,
    },
    {
      id: "cost",
      title: "Hình ảnh và chi phí",
      html: p("Hình ảnh được gửi lại ở mỗi lời gọi của một " + c("/discuss") + " và của một pipeline (mỗi bước, lần thử lại và lần sửa là một lời gọi riêng), mỗi lần đều tốn token và thời gian. Hãy đính kèm hình ảnh vào tin nhắn cần chúng, và ưu tiên ảnh chụp màn hình đã cắt hơn là toàn màn hình."),
    },
    {
      id: "storage",
      title: "Nơi lưu các bản sao",
      html: `${ul([
  `Các tệp của một cuộc hội thoại được sao chép, giữ nguyên byte, vào ${c(".agentduo/runs/conversations/<id>/attachments/")}.`,
  `Các tệp của một tác vụ pipeline nằm trong thư mục ${c("attachments/")} của lượt chạy, nên ${c("/resume")} không cần bản gốc lẫn cuộc hội thoại.`,
  "Các bản sao không bao giờ nằm trong snapshot hay trong diff mà người review thấy.",
  `Một tệp đang chờ gửi sẽ bị bỏ bởi ${c("/new")} và khi chat, tab hoặc ứng dụng đóng; tệp đã gửi thì được giữ lại. Nhật ký prompt (${c("prompt.md")}) chỉ ghi văn bản, không bao giờ ghi dữ liệu của hình ảnh.`,
])}
${note(p("Tại một quyết định, các tệp đang chờ không đi cùng câu trả lời của bạn: hãy gửi chúng kèm một tin nhắn trước, hoặc chọn Decide later rồi " + c("/resume") + " kèm ghi chú. " + link("docs/decisions-resume#answers", "Câu trả lời của bạn") + "."))}`,
    },
  ],
  related: ["docs/conversations", "docs/data-diagnostics", "troubleshooting#windows-paths"],
});
