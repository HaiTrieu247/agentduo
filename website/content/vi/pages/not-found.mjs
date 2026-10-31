export default ({ link, p, ul }, d) => ({
  title: "Không tìm thấy trang",
  description: "Địa chỉ này không có trang nào trên trang web AgentDuo. Hãy tìm thứ bạn cần từ trang chủ, tài liệu, trang tải về hoặc tìm kiếm.",
  noToc: true,
  lead: p("Không có trang nào ở địa chỉ này. Trang có thể đã được chuyển, hoặc liên kết bị gõ sai."),
  top: `<form class="search-page-form" role="search" action="/search/" method="get">
<label class="visually-hidden" for="not-found-search">Tìm trong trang web</label>
<input id="not-found-search" type="search" name="q" autocomplete="off" placeholder="Tìm trong tài liệu" data-search-input>
<button type="submit">Tìm</button>
</form>`,
  sections: [
    {
      id: "where-to-go",
      title: "Đi tiếp đến đâu",
      html: ul([
        `${link("home", "Trang chủ")}: AgentDuo là gì và hoạt động ra sao.`,
        `${link("docs", d.titles?.docs ?? "Tài liệu")}: mọi chủ đề, từ hội thoại đến tham chiếu cấu hình.`,
        `${link("learn", d.titles?.learn ?? "Học")}: cài AgentDuo và chạy tác vụ đầu tiên.`,
        `${link("download", "Tải về")}: ứng dụng desktop, lệnh ${"<code>duo</code>"} và tiện ích VS Code.`,
        `${link("troubleshooting", "Khắc phục sự cố")}: cách sửa các sự cố thường gặp.`,
      ]),
    },
    {
      id: "report",
      title: "Báo liên kết hỏng",
      html: p(`Nếu một liên kết trên trang web này đưa bạn đến đây, hãy <a href="${d.site.links.newIssue}" rel="noopener">mở một issue</a> kèm trang bạn đã đi từ đó.`),
    },
  ],
});
