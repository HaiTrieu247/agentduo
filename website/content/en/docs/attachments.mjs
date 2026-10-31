export default ({ c, link, code, p, ul, table, note }) => ({
  title: "Files and images",
  description: "Attach files and images to AgentDuo messages: how in each interface, path quoting, limits, where the copies are stored, and what Claude Code and Codex receive.",
  lead: p("You can attach any kind of file (images, PDFs, text, code) to your next message, question, " + c("/discuss") + ", " + c("/pipeline") + " task or note. AgentDuo copies each file and tells both agents where the copy is."),
  sections: [
    {
      id: "how",
      title: "Attaching",
      html: `${table({
  caption: "How to attach files in each interface",
  head: ["Interface", "How"],
  rows: [
    ["Desktop app", "The attach button, paste an image, or drop files on the composer."],
    ["VS Code", "The paperclip, paste an image (Cmd/Ctrl+V), or hold Shift while dragging files from Finder or Explorer onto the composer. A drag from VS Code’s own Explorer carries no file: use the paperclip."],
    ["Terminal", c("/attach <path>") + " for each file; " + c("/attachments") + " lists the waiting files and " + c("/detach <n|all>") + " removes them. The terminal does not read images from the clipboard: save the image, then attach it."],
  ],
})}
${p("The files wait until you send them with your next message. Sending with an empty input sends the files alone (to the agent named under the input, or as a note while a pipeline works).")}`,
    },
    {
      id: "paths",
      title: "Paths in /attach",
      html: `${p("The terminal reads the path the way a shell reads one word:")}
${code(`/attach notes.md
/attach "~/Desktop/My notes.pdf"
/attach shots/bug\\ 2.png
/attach "it's.png"`, { label: "duo" })}
${ul([
  `A relative path starts from the workspace; ${c("~/")} from your home folder, quoted or not. Write ${c("\\~")} or ${c("./~")} for a folder named ${c("~")}. Nothing is globbed or expanded.`,
  `A literal ${c("'")} goes in double quotes; ${c("'it''s'")} reads as ${c("its")}, as in the shell.`,
  `On Windows a backslash separates folders and escapes nothing, so a path with spaces goes in quotes (${c('/attach "C:\\Users\\me\\My notes.pdf"')}), and ${c("~\\")} is your home folder too.`,
])}`,
    },
    {
      id: "limits",
      title: "Limits",
      html: `${table({
  caption: "Attachment limits",
  head: ["Limit", "Value"],
  rows: [
    ["Files per message", "20"],
    ["Size of one file", "20 MB"],
    ["All files of one message", "50 MB"],
    ["Images sent to Claude as images, per call", "20, each at most 8000 pixels on a side and 5 MB once base64-encoded, 20 MB in all"],
    ["Images sent to Codex as images, per call", "20"],
  ],
})}`,
    },
    {
      id: "what-agents-get",
      title: "What the agents receive",
      html: `${ul([
  "Every prompt lists the attached files with the paths of their copies, so both agents can read them with their own tools. Whether an agent can make sense of a given binary file is up to it.",
  `PNG, JPEG, GIF and WebP images also go to the model as images: to Claude as image blocks of a ${c("stream-json")} message, to Codex with ${c("--image=<path>")}.`,
  "An image past Claude’s limits, one whose size AgentDuo cannot read, or an SVG goes as a path only, and a warning says so.",
  "A later question only lists an earlier message’s files by path; the images are not sent again.",
])}`,
    },
    {
      id: "cost",
      title: "Images and cost",
      html: p("Images are sent again with every call of a " + c("/discuss") + " and of a pipeline (each step, retry and repair is a call of its own), which costs tokens and time each time. Attach images to the message that needs them, and prefer a cropped screenshot to a full screen."),
    },
    {
      id: "storage",
      title: "Where the copies are kept",
      html: `${ul([
  `A conversation’s files are copied, bytes unchanged, into ${c(".agentduo/runs/conversations/<id>/attachments/")}.`,
  `A pipeline task’s files go into its run’s ${c("attachments/")} folder, so ${c("/resume")} needs neither the original nor the conversation.`,
  "Copies are never part of a snapshot or of the diff the reviewer sees.",
  `A file waiting to be sent is dropped by ${c("/new")} and when the chat, tab or app closes; a sent one stays. The prompt log (${c("prompt.md")}) records the text only, never the images’ data.`,
])}
${note(p("At a decision, waiting files do not go with your answer: send them with a message first, or choose Decide later and " + c("/resume") + " with a note. " + link("docs/decisions-resume#answers", "Your answers") + "."))}`,
    },
  ],
  related: ["docs/conversations", "docs/data-diagnostics", "troubleshooting#windows-paths"],
});
