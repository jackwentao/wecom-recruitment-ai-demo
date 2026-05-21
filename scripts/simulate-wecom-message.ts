import axios from "axios";

const content =
  process.argv.slice(2).join(" ") ||
  "@招聘助手 张三 Java后端候选人，明天下午3点一面，简历不错，王工跟进，手机号13800138000";

const response = await axios.post("http://localhost:3001/api/messages/simulate", {
  content,
  sender: "本地模拟",
  groupName: "招聘内部协作群"
});

console.log(JSON.stringify(response.data, null, 2));
