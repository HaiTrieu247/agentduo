export default ({ c, link, code, ext, p, ul, table, note }) => ({
  title: "Đóng góp",
  description: "Build AgentDuo từ mã nguồn: CLI, extension VS Code, ứng dụng desktop và website này, các quy ước của mã nguồn, và cách báo cáo sự cố một cách an toàn.",
  lead: p("AgentDuo nằm trong một kho duy nhất: CLI " + c("duo") + " trong " + c("src/") + ", extension VS Code trong " + c("extensions/vscode") + ", ứng dụng desktop trong " + c("apps/desktop") + " và website này trong " + c("website/") + ". Tất cả đều build bằng Node.js ≥ 22.12 và npm."),
  sections: [
    {
      id: "source",
      title: "Build CLI từ mã nguồn",
      html: `${code("git clone https://github.com/HaiTrieu247/agentduo.git\ncd agentduo\nnpm ci\nnpm run build", { lang: "sh", label: "Terminal" })}
${p(c("npm run build") + " đóng gói CLI vào " + c("dist/") + ". Chạy nó bằng " + c("node dist/cli.js") + ", hoặc " + c("npm link") + " để đưa " + c("duo") + " và " + c("agentduo") + " vào PATH.")}
${table({
  caption: "Các script ở thư mục gốc",
  head: ["Lệnh", "Tác dụng"],
  rows: [
    [c("npm test"), "Test đơn vị, workflow và UI (Vitest). Các kịch bản workflow điều khiển một agent giả qua tiến trình con thật, nên không tốn phí."],
    [c("npm run typecheck"), "Kiểm tra TypeScript ở chế độ strict."],
    [c("npm run test:pack"), "Build, đóng gói và cài package vào một prefix tạm, rồi chạy các tệp thực thi của nó."],
    [c("npm run demo:ui"), "Giao diện terminal trực tiếp với các agent giả theo kịch bản (miễn phí)."],
    [c("npm run smoke:real"), "Agent thật trên một kho demo. Lệnh này tốn tiền."],
  ],
})}`,
    },
    {
      id: "vscode",
      title: "Extension VS Code",
      html: `${p("Extension được build từ thư mục gốc, bằng bộ công cụ của thư mục gốc:")}
${table({
  caption: "Các script của extension",
  head: ["Lệnh", "Tác dụng"],
  rows: [
    [c("npm run typecheck:vscode"), "Kiểm tra TypeScript của extension."],
    [c("npm run build:vscode"), "Build " + c("extensions/vscode/dist") + " (host và webview) và " + c("runtime/") + " (engine worker và các schema)."],
    [c("npm run test:vscode"), "Smoke test trong một bản VS Code được tải về; trên Linux, chạy nó dưới " + c("xvfb-run") + "."],
    [c("npm run package:vscode"), "Tạo " + c("extensions/vscode/agentduo-vscode-<version>.vsix") + ", để cài bằng " + c("code --install-extension") + "."],
    [c("npm run test:pack:vscode"), "Đóng gói, kiểm tra nội dung VSIX và chạy worker của nó bên ngoài thư mục mã nguồn."],
  ],
})}
${p("Để phát triển extension, mở kho trong VS Code và nhấn " + c("F5") + " (<em>Run agentduo extension</em>): VS Code sẽ build extension và mở một Extension Development Host.")}`,
    },
    {
      id: "desktop",
      title: "Ứng dụng desktop",
      html: `${p("Gói desktop build từ mã nguồn trong kho bằng bộ công cụ của thư mục gốc, nên hãy cài thư mục gốc trước, rồi đến các devDependencies riêng của desktop (Electron, electron-builder, @electron/fuses, electron-updater, Playwright):")}
${code("npm ci\nnpm ci --prefix apps/desktop", { lang: "sh", label: "Terminal" })}
${table({
  caption: "Các script của desktop (npm --prefix apps/desktop run …)",
  head: ["Script", "Tác dụng"],
  rows: [
    [c("dev"), "Build, rồi mở ứng dụng từ " + c("dist/") + "."],
    [c("build"), "Đóng gói main, preload, renderer và engine worker vào " + c("dist/") + "."],
    [c("typecheck"), "Kiểm tra TypeScript của desktop."],
    [c("test"), "Test đơn vị và tích hợp của desktop."],
    [c("test:e2e"), "Test end-to-end Electron (Playwright): ứng dụng thật với các CLI giả trong một dự án Git tạm, được điều khiển như một người dùng."],
    [c("pack:dir"), "Một bản ứng dụng chưa đóng gói cho hệ điều hành hiện tại, trong " + c("release/") + "."],
    [c("test:pack"), "Kiểm tra bản chưa đóng gói đó khi đặt bên ngoài thư mục mã nguồn."],
    [c("package:mac") + ", " + c("package:win") + ", " + c("package:linux"), "Các trình cài đặt. Gói là native: build gói của mỗi hệ điều hành trên chính hệ điều hành đó."],
  ],
})}
${p("Khi thay đổi ứng dụng desktop, hãy chạy " + c("typecheck") + ", " + c("test") + ", " + c("build") + " và " + c("test:e2e") + ". Phiên bản của nó theo phiên bản ở thư mục gốc; " + c("npm version") + " giữ chúng đồng bộ.")}`,
    },
    {
      id: "website",
      title: "Website này",
      html: `${p("Website là HTML tĩnh sinh ra từ " + c("website/content") + ", bằng tiếng Anh và tiếng Việt. Không cần cài đặt gì:")}
${code("cd website\nnpm run build\nnpm test\nnpm run preview", { lang: "sh", label: "Terminal" })}
${p("Trong lúc viết một trang, " + c("node scripts/check-page.mjs <page id>") + " kiểm tra trang đó ở mọi ngôn ngữ mà không cần build cả website. Mỗi mục và tiêu đề con phải có ở cả hai ngôn ngữ.")}`,
    },
    {
      id: "conventions",
      title: "Quy ước",
      html: `${ul([
  `AgentDuo không áp đặt gì. Nó chỉ truyền các cờ giao thức, cộng với ${c("args")} và ${c("role_args")} của bạn; thay đổi bất thường trở thành cảnh báo, không bao giờ chặn. Quy tắc quyền thuộc về cấu hình riêng của từng CLI.`,
  `Dependency lúc chạy chỉ gồm đúng ${c("ink")}, ${c("react")}, ${c("commander")}, ${c("yaml")} và ${c("ajv")}. Hãy hỏi trước khi thêm một cái mới.`,
  `Node ≥ 22.12, ESM, TypeScript strict. Import tương đối kết thúc bằng ${c(".js")}, kể cả với tệp ${c(".ts")} và ${c(".tsx")}.`,
  `${c("src/core")} và ${c("src/agents")} không bao giờ import từ ${c("src/ui")}: mọi thứ hiện lên màn hình đều là một sự kiện, và quyết định của con người quay lại qua một interface.`,
  `Một chuyển trạng thái workflow được thay đổi cần có kịch bản trong ${c("test/workflow.test.ts")}. Schema đầu ra của agent phải giữ chuẩn OpenAI-strict (mọi thuộc tính đều required, không có thuộc tính thừa), điều mà ${c("test/schema.test.ts")} kiểm tra.`,
  `CI chạy test trên Linux, macOS và Windows. Trong test, dựng đường dẫn bằng ${c("join")}, và không bao giờ chỉ dùng ${c("XDG_CONFIG_HOME")} để đặt thư mục cấu hình người dùng: Windows đọc ${c("%APPDATA%")}.`,
])}
${p("Danh sách đầy đủ nằm trong " + c("AGENTS.md") + " ở thư mục gốc của kho.")}`,
    },
    {
      id: "report",
      title: "Báo cáo sự cố",
      html: `${p("Mở một issue trên " + ext("https://github.com/HaiTrieu247/agentduo/issues", "GitHub") + ". Trước đó, hãy xem " + link("troubleshooting", "Khắc phục sự cố") + ". Hãy kèm theo:")}
${ul([
  `Phiên bản AgentDuo (${c("duo --version")}; của extension trong khung Extensions của VS Code; của ứng dụng desktop trong Settings → General) và phiên bản của ${c("claude")} và ${c("codex")}.`,
  "Hệ điều hành và phiên bản của nó, cùng giao diện bạn đã dùng.",
  `Đầu ra của ${c("duo doctor")}, hoặc bản xuất từ Settings → Diagnostics của ứng dụng desktop.`,
  "Bạn đã làm gì, bạn mong đợi gì và điều gì đã xảy ra, kèm nội dung cảnh báo hoặc lỗi.",
])}
${note(`${p("Issue là công khai. Trước khi đăng bất cứ thứ gì:")}${ul([
  "Thay địa chỉ email, tên người dùng và đường dẫn thư mục home (ví dụ bằng " + c("/repo") + " hoặc " + c("~") + ").",
  "Xoá token, API key và mọi thứ lấy từ tệp chứa thông tin đăng nhập.",
  "Đừng đính kèm thư mục lượt chạy hay cuộc hội thoại từ mã nguồn riêng tư: chúng chứa prompt của bạn, đầu ra của các agent và diff các tệp của bạn. Chỉ sao chép những dòng cho thấy sự cố.",
])}`, "warning")}`,
    },
    {
      id: "license",
      title: "Giấy phép",
      html: p("AgentDuo được phát hành theo Giấy phép MIT (" + c("LICENSE") + " trong kho)."),
    },
  ],
  related: ["troubleshooting", "docs/data-diagnostics", "docs/cli", "download"],
});
