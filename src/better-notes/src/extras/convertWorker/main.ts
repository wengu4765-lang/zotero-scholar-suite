import { MessageHelper } from "zotero-plugin-toolkit";

import {
  note2rehype,
  rehype2remark,
  rehype2note,
  remark2rehype,
  remark2md,
  remark2latex,
  md2remark,
  content2diff,
  md2html,
  rehype2md,
  rehype2latex,
  html2md,
  md2rehype,
} from "../convert";

export { handlers };

const handlers = {
  note2rehype,
  rehype2remark,
  rehype2note,
  remark2rehype,
  remark2md,
  remark2latex,
  md2remark,
  content2diff,
  md2html,
  rehype2md,
  rehype2latex,
  html2md,
  md2rehype,
};

const messageServer = new MessageHelper({
  canBeDestroyed: true,
  dev: true,
  name: "convertWorker",
  target: self,
  handlers,
});

messageServer.start();
