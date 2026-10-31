export default ({ c, link, code, p, ul, steps, note }) => ({
  title: "Thảo luận với /discuss",
  description: "Cách /discuss hoạt động: một agent trả lời, agent kia review kèm kết luận, sửa đến khi đồng ý, và Codex tổng hợp câu trả lời cuối. Giới hạn và chi phí.",
  lead: p(c("/discuss <question>") + " để cả hai agent cùng tìm ra một câu trả lời thay vì mỗi bên tự đưa ra câu của mình. Dùng cho câu hỏi thiết kế, review một cách tiếp cận, hoặc bất cứ việc gì mà ý kiến thứ hai nên định hình câu trả lời."),
  sections: [
    {
      id: "how",
      title: "Một cuộc thảo luận diễn ra thế nào",
      html: `${steps([
  ["Trả lời", p("Agent có tên bên dưới ô nhập trả lời câu hỏi.")],
  ["Review", p("Agent kia review câu trả lời đó và kết thúc bằng " + c("VERDICT: AGREE") + " hoặc " + c("VERDICT: REVISE") + ". Một bản review không có verdict được tính là REVISE.")],
  ["Sửa", p("Cho đến khi reviewer đồng ý, agent đầu tiên sửa câu trả lời và agent kia review lại, tối đa " + c("limits.max_discussion_rounds") + " lần review (mặc định là 3).")],
  ["Tổng hợp", p("Codex, trong một lần gọi riêng, viết câu trả lời cuối từ toàn bộ cuộc thảo luận: giữ những gì đứng vững của cả hai agent, bổ sung các điểm trong review mà phiên bản cuối còn thiếu, và bỏ những gì cuộc thảo luận cho thấy là sai.")],
])}
${code("/discuss Should the cache be invalidated on write or with a TTL here?", { label: "duo" })}`,
    },
    {
      id: "result",
      title: "Bạn nhận được gì",
      html: `${ul([
  "Mỗi lượt được hiển thị khi nó kết thúc, kèm verdict của reviewer. Trong terminal bạn thấy vài dòng đầu của mỗi lượt (" + c("--verbose") + " hiển thị đầy đủ); trong ứng dụng desktop và VS Code, các lượt gộp thành một dòng khi cuộc thảo luận kết thúc.",
  "Sau đó là câu trả lời cuối, đầy đủ. Chỉ câu trả lời đó được thêm vào cuộc trò chuyện, dưới dạng câu trả lời của Codex đã thảo luận với Claude.",
  "Nếu bản review cuối vẫn yêu cầu thay đổi, câu trả lời kết thúc bằng một mục ngắn về những điểm còn tranh cãi.",
  "Nếu bước tổng hợp thất bại, một cảnh báo sẽ báo, và phiên bản mới nhất là câu trả lời, từ agent đã viết nó.",
])}
${note(p("Codex luôn viết bản tổng hợp. Khi Codex cũng là bên trả lời, bản tổng hợp đến từ cùng model đó, trong một lần gọi mới được yêu cầu giữ trung lập."))}`,
    },
    {
      id: "cost",
      title: "Số lần gọi và giới hạn",
      html: `${ul([
  `Một cuộc thảo luận thực hiện từ 3 đến 2N+1 lần gọi agent, với N là ${c("limits.max_discussion_rounds")}: tối thiểu một câu trả lời, một bản review và bước tổng hợp.`,
  `${c("limits.max_discussion_rounds")} được đọc khi cuộc thảo luận bắt đầu: đổi nó khi một cuộc đang diễn ra sẽ áp dụng cho cuộc kế tiếp.`,
  `Ảnh đính kèm được gửi lại trong mọi lần gọi của cuộc thảo luận. ${link("docs/attachments#cost", "Ảnh và chi phí")}.`,
  `${c("Esc")} dừng cuộc thảo luận; không có gì của nó được thêm vào cuộc trò chuyện.`,
])}`,
    },
    {
      id: "when",
      title: "Khi nào nên dùng",
      html: `${ul([
  `<strong>${c("/discuss")}</strong> cho câu hỏi có câu trả lời cần được kiểm chứng: một lựa chọn thiết kế, đánh giá rủi ro, một kế hoạch bạn muốn tinh chỉnh trước ${c("/pipeline")}.`,
  `<strong>Tin nhắn thường</strong> cho câu trả lời nhanh từ một agent.`,
  `<strong>${c("/pipeline")}</strong> khi câu trả lời là một thay đổi mã: pipeline lập kế hoạch, triển khai, kiểm tra và review nó.`,
])}`,
    },
  ],
  related: ["docs/conversations", "docs/pipeline", "docs/config-reference#limits"],
});
