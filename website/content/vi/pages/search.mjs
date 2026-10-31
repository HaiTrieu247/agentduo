import { SECTIONS } from "../../navigation.mjs";

export default ({ link, p, esc }, d) => {
  const groups = Object.entries(SECTIONS).flatMap(([, gs]) => gs);
  const LABELS = { start: "Học", overview: "Tổng quan", using: "Dùng AgentDuo", configure: "Cấu hình", reference: "Tham chiếu", help: "Trợ giúp" };
  return {
    title: "Tìm kiếm",
    description: "Tìm trong tài liệu, hướng dẫn và các trang sản phẩm của AgentDuo theo tiêu đề và nội dung. Dùng chỉ mục riêng của trang web này, không cần dịch vụ tìm kiếm.",
    noToc: true,
    top: `<div class="search-page" data-search-page data-index="/vi/search-index.json"
 data-empty="Nhập một hai từ, ví dụ pipeline, gate hoặc resume."
 data-loading="Đang tải chỉ mục tìm kiếm…"
 data-none="Không có kết quả cho “{q}”. Hãy thử ít từ hơn hoặc từ khác, hoặc duyệt các trang bên dưới."
 data-one="1 kết quả cho “{q}”"
 data-many="{n} kết quả cho “{q}”"
 data-error="Không tải được chỉ mục tìm kiếm. Hãy duyệt các trang bên dưới.">
<form class="search-page-form" role="search" action="/search/" method="get">
<label class="visually-hidden" for="search-page-input">Tìm trong trang web</label>
<input id="search-page-input" type="search" name="q" autocomplete="off" spellcheck="false" data-search-input>
<button type="submit">Tìm</button>
</form>
<p class="search-status" role="status" data-search-status></p>
<ol class="search-results" data-search-results></ol>
<noscript><p>Tìm kiếm cần JavaScript, đang tắt trong trình duyệt này. Mọi trang đều được liệt kê bên dưới.</p></noscript>
<div data-search-fallback hidden><p>Mọi trang đều được liệt kê bên dưới.</p></div>
</div>`,
    sections: [
      {
        id: "browse",
        title: "Duyệt thay thế",
        html: `${groups.map((g) => `<h3>${esc(LABELS[g.key])}</h3><ul>${g.pages.map((id) => `<li>${link(id, d.titles?.[id] ?? id)}</li>`).join("")}</ul>`).join("")}
<h3>Sản phẩm</h3><ul><li>${link("home", "Trang chủ")}</li><li>${link("about", "Giới thiệu AgentDuo")}</li><li>${link("download", "Tải AgentDuo")}</li><li>${link("releases", "Phát hành")}</li><li>${link("faq", "Câu hỏi thường gặp")}</li></ul>`,
      },
    ],
    scripts: ["search.js"],
  };
};
