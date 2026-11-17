export const session = {
  id: 'sess-1', title: '一个分支会话',
  inserted_at: 1710000000, updated_at: 1710003600,
  current_message_id: 5,
}
export const messages = [
  { message_id: 1, parent_id: null, role: 'USER', inserted_at: 1710000000,
    content: '旧格式提问', files: [{ id: 'f-img', file_name: 'shot.png', content_type: 'image/png' }] },
  { message_id: 2, parent_id: 1, role: 'ASSISTANT', inserted_at: 1710000010,
    content: '旧格式回答', thinking_content: '旧格式思维' },
  { message_id: 3, parent_id: 2, role: 'USER', inserted_at: 1710000020,
    fragments: [{ type: 'REQUEST', content: '新格式提问' }],
    files: [{ id: 'f-doc', file_name: 'report.pdf', file_size: 2048 }] },
  { message_id: 5, parent_id: 3, role: 'ASSISTANT', inserted_at: 1710000030,
    fragments: [
      { type: 'SEARCH', content: '搜索了 3 个网页' },
      { type: 'THINK', content: '新格式思维' },
      { type: 'RESPONSE', content: '新格式回答' },
    ] },
  { message_id: 9, parent_id: 3, role: 'ASSISTANT', inserted_at: 1710000040,
    fragments: [{ type: 'RESPONSE', content: '另一个分支（不该出现）' }] },
]
