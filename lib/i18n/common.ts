// lib/i18n/common.ts
//
// 公共词字典 —— 在多个组件中重复出现的短文案集中在这里。
// 长文案、错误消息、占位符不放这里，由各组件文件顶部的 const T = {...} 块管。

export const COMMON = {
  cancel: "取消",
  confirm: "确认",
  save: "保存",
  delete: "删除",
  copy: "复制",
  copied: "已复制",
  retry: "重试",
  close: "关闭",
  create: "新建",
  refresh: "刷新",
  loading: "加载中…",
  edit: "编辑",
  rename: "重命名",
  preview: "预览",
  download: "下载",
  upload: "上传",
  back: "返回",
  next: "下一步",
  previous: "上一步",
} as const;
