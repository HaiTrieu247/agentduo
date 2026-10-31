// Tiếng Việt: các từ giao diện và một module cho mỗi id trang (content/navigation.mjs liệt kê các id).
import about from "./pages/about.mjs";
import download from "./pages/download.mjs";
import faq from "./pages/faq.mjs";
import home from "./pages/home.mjs";
import notFound from "./pages/not-found.mjs";
import releases from "./pages/releases.mjs";
import search from "./pages/search.mjs";
import troubleshooting from "./pages/troubleshooting.mjs";
import learn from "./learn/index.mjs";
import learnPrerequisites from "./learn/prerequisites.mjs";
import learnDesktop from "./learn/desktop.mjs";
import learnCli from "./learn/cli.mjs";
import learnVscode from "./learn/vscode.mjs";
import learnFirstTask from "./learn/first-task.mjs";
import docs from "./docs/index.mjs";
import concepts from "./docs/concepts.mjs";
import conversations from "./docs/conversations.mjs";
import discuss from "./docs/discuss.mjs";
import pipeline from "./docs/pipeline.mjs";
import decisionsResume from "./docs/decisions-resume.mjs";
import attachments from "./docs/attachments.mjs";
import configuration from "./docs/configuration.mjs";
import permissions from "./docs/permissions.mjs";
import accountsUsage from "./docs/accounts-usage.mjs";
import desktopUpdates from "./docs/desktop-updates.mjs";
import dataDiagnostics from "./docs/data-diagnostics.mjs";
import cli from "./docs/cli.mjs";
import slashCommands from "./docs/slash-commands.mjs";
import configReference from "./docs/config-reference.mjs";
import contributing from "./docs/contributing.mjs";

const ARCH = { arm64: "Apple silicon", x64: "Intel" };
const OS = { mac: "macOS", windows: "Windows", linux: "Linux" };
const ARCH_NAMES = { mac: { arm64: "Apple silicon (arm64)", x64: "Intel (x64)" }, windows: { x64: "x64", arm64: "Arm64" }, linux: { x64: "x86_64 (amd64)", arm64: "arm64" } };

export default {
  locale: "vi",
  strings: {
    logoAlt: "Biểu trưng AgentDuo: một chấm xanh lam và một chấm cam trên cùng một vòng lặp",
    skip: "Chuyển đến nội dung",
    mainNav: "Chính",
    menu: "Menu",
    nav: { home: "Trang chủ", learn: "Học", docs: "Tài liệu", download: "Tải về", about: "Giới thiệu", releases: "Phát hành", faq: "Hỏi đáp" },
    short: {
      learn: "Bắt đầu từ đây",
      "learn/prerequisites": "Bạn cần gì",
      "learn/desktop": "Ứng dụng desktop",
      "learn/cli": "Terminal (duo)",
      "learn/vscode": "Tiện ích VS Code",
      "learn/first-task": "Tác vụ đầu tiên",
      docs: "Tổng quan",
      "docs/concepts": "Cách hoạt động",
      "docs/conversations": "Hội thoại",
      "docs/discuss": "Thảo luận",
      "docs/pipeline": "Pipeline",
      "docs/decisions-resume": "Quyết định, dừng và tiếp tục",
      "docs/attachments": "Tệp và hình ảnh",
      "docs/configuration": "Cấu hình",
      "docs/permissions": "Quyền",
      "docs/accounts-usage": "Tài khoản & mức dùng",
      "docs/desktop-updates": "Cập nhật ứng dụng desktop",
      "docs/data-diagnostics": "Dữ liệu, nhật ký, chẩn đoán",
      "docs/cli": "Lệnh duo",
      "docs/slash-commands": "Lệnh slash",
      "docs/config-reference": "Khóa config.yaml",
      troubleshooting: "Khắc phục sự cố",
      "docs/contributing": "Build và đóng góp",
    },
    groups: { start: "Bắt đầu", overview: "Tổng quan", using: "Dùng AgentDuo", configure: "Cấu hình", reference: "Tham chiếu", help: "Trợ giúp" },
    sectionNav: { learn: "Học", docs: "Tài liệu" },
    browse: { learn: "Tất cả trang Học", docs: "Tất cả trang tài liệu" },
    breadcrumb: "Đường dẫn trang",
    toc: "Trên trang này",
    pager: { label: "Trang trước và trang sau", prev: "Trước", next: "Sau" },
    related: "Trang liên quan",
    nextStep: "Bước tiếp theo",
    callout: { note: "Ghi chú", warning: "Cảnh báo", tip: "Mẹo" },
    search: {
      label: "Tìm trong trang web", placeholder: "Tìm kiếm", button: "Tìm",
      dialog: {
        placeholder: "Tìm trong tài liệu, bài hướng dẫn và các trang",
        cancel: "Huỷ",
        close: "Đóng tìm kiếm",
        results: "Kết quả tìm kiếm",
        recent: "Tìm kiếm gần đây",
        clear: "Xoá",
        loading: "Đang tải chỉ mục tìm kiếm…",
        error: "Không tải được chỉ mục tìm kiếm. Nhấn Enter để mở trang Tìm kiếm.",
        none: "Không có kết quả cho “{q}”. Hãy kiểm tra chính tả hoặc bớt từ.",
        one: "1 kết quả",
        many: "{n} kết quả",
        all: "Xem tất cả {n} kết quả",
        move: "chọn", open: "mở", dismiss: "đóng",
      },
    },
    theme: { label: "Giao diện", system: "Theo hệ thống", light: "Sáng", dark: "Tối" },
    copy: { button: "Sao chép", label: "Sao chép đoạn mã này", copied: "Đã sao chép", failed: "Sao chép thất bại: đoạn mã đã được chọn, hãy nhấn Ctrl+C (⌘C trên Mac)" },
    footer: {
      label: "Chân trang",
      columns: { product: "Sản phẩm", learn: "Học", help: "Trợ giúp", project: "Dự án" },
      about: "Codex và Claude Code trên cùng một vòng lặp: một bên lập kế hoạch và review, bên kia phản biện và triển khai, còn bạn đưa ra quyết định.",
      source: "Mã nguồn trên GitHub",
      report: "Báo lỗi",
      pulls: "Pull request",
      license: "Giấy phép MIT",
      npm: "Gói npm",
      marketplace: "VS Code Marketplace",
      legal: "AgentDuo là mã nguồn mở theo giấy phép MIT. Dự án không liên kết với Anthropic hay OpenAI: Claude Code và Codex là sản phẩm của họ, dùng với tài khoản của chính bạn.",
      privacy: "Trang web này không đặt cookie, không có phân tích hay theo dõi. Lựa chọn giao diện và các tìm kiếm gần đây của bạn chỉ lưu trong trình duyệt.",
    },
    downloads: {
      kinds: { dmg: "Ảnh đĩa (.dmg)", nsis: "Trình cài đặt (.exe)", appimage: "AppImage", deb: "Gói Debian (.deb)" },
      arch: ARCH_NAMES,
      download: (kind, arch) => ({
        dmg: `Tải về cho ${ARCH[arch]}`,
        nsis: "Tải trình cài đặt",
        appimage: "Tải AppImage",
        deb: "Tải gói .deb",
      })[kind],
      checksum: "Checksum SHA-256",
      unavailable: (os, arch) => `Chưa có bản dựng ${OS[os]} cho ${ARCH_NAMES[os][arch]} được phát hành.`,
    },
  },
  pages: {
    home, about, download, releases, faq, troubleshooting, search, "not-found": notFound,
    learn, "learn/prerequisites": learnPrerequisites, "learn/desktop": learnDesktop, "learn/cli": learnCli, "learn/vscode": learnVscode,
    "learn/first-task": learnFirstTask,
    docs, "docs/concepts": concepts, "docs/conversations": conversations, "docs/discuss": discuss, "docs/pipeline": pipeline,
    "docs/decisions-resume": decisionsResume, "docs/attachments": attachments, "docs/configuration": configuration,
    "docs/permissions": permissions, "docs/accounts-usage": accountsUsage, "docs/desktop-updates": desktopUpdates,
    "docs/data-diagnostics": dataDiagnostics, "docs/cli": cli, "docs/slash-commands": slashCommands,
    "docs/config-reference": configReference, "docs/contributing": contributing,
  },
};
