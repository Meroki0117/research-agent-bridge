import { terminal, type EventKind, type Task, type TaskEvent } from './schema.js';

const labels: Record<EventKind|string,string> = {
  queued:'排队中',started:'准备上下文',request_started:'等待模型响应',output_started:'正在生成正文',
  response_received:'已收到模型响应',retry_scheduled:'等待重试',tool_started:'调用工具',tool_completed:'工具完成',tool_failed:'工具失败',
  completed:'已完成 · 待总调度审查',failed:'执行失败',cancelled:'已取消',timed_out:'执行超时',budget_exceeded:'预算耗尽',interrupted:'运行中断',blocked:'前置任务失败',running:'运行中',
};
const toolLabels:Record<string,string>={read_context:'读取上下文',read_material:'读取材料',propose_memory:'提议记忆',unsupported_tool:'未支持的工具'};
export function eventLabel(event:Pick<TaskEvent,'kind'|'tool_name'>):string {
  return (labels[event.kind]??event.kind)+(event.tool_name?'：'+(toolLabels[event.tool_name]??event.tool_name):'');
}
export function timing(task:Task,now=Date.now()) {
  const end=Date.parse(task.finished_at??'')||now;
  const created=Date.parse(task.created_at), started=task.started_at?Date.parse(task.started_at):undefined;
  return {elapsed_ms:Math.max(0,end-created),queued_ms:Math.max(0,(started??end)-created),execution_ms:started?Math.max(0,end-started):0};
}
const escape=(text:string,max=300)=>text.replace(/[\r\n\t]+/g,' ').slice(0,max).replace(/[\\`*_{}\[\]()<>#!|~]/g,'\\$&');
const seconds=(ms:number)=>(ms/1000).toFixed(1)+' 秒';
export function presentTask(task:Task,events:TaskEvent[],lastEventId:number,now=Date.now()) {
  const times=timing(task,now);
  const phase=terminal(task.state)?task.state:task.phase??(task.state==='queued'?'queued':'started');
  const excerpt=(task.result??task.partial_result??'').slice(0,400);
  const label=labels[phase]??phase;
  const tools=[...new Set(task.tools_used)].map(t=>toolLabels[t]??t).join('、')||'尚无';
  const lines=[
    `**外部 Agent · ${escape(task.role,80)} · ${task.id.slice(0,8)}**`,
    `模型：${escape(task.profile.provider,80)} / ${escape(task.profile.model,120)} ｜ 阶段：${label}`,
    `耗时：${seconds(times.elapsed_ms)}（排队 ${seconds(times.queued_ms)}，执行 ${seconds(times.execution_ms)}）｜ 请求：${task.requests}/${task.max_requests}`,
    `工具：${escape(tools,240)}${task.current_tool?' ｜ 当前：'+escape(task.current_tool,80):''}`,
  ];
  if((task.visible_output_chars??0)>0) lines.push(`本轮已接收正文：${task.visible_output_chars} 字符（不是完成百分比）`);
  if(events.length) lines.push('最近进度：'+events.slice(-4).map(e=>`${seconds(e.elapsed_ms)} ${eventLabel(e)}`).join(' → '));
  if(task.error_code) lines.push(`原因：${escape(task.error_code,100)}`);
  if(excerpt) lines.push(`${task.result===undefined?'部分结果':'结果'}摘录（未经总调度核验）：${escape(excerpt,400)}${(task.result??task.partial_result??'').length>400?'…':''}`);
  if(task.state==='queued'&&task.submission.depends_on.length) lines.push('等待前置任务完成及空闲执行槽位。');
  if(!lastEventId) lines.push('此任务没有可用事件记录（可能由旧版本创建）。');
  return {...times,phase,phase_label:label,event_cursor:lastEventId,
    recent_events:events.map(e=>({...e,label:eventLabel(e)})),
    result_excerpt:excerpt||undefined,result_is_partial:task.result===undefined&&task.partial_result!==undefined,
    display_markdown:lines.join('\n\n'),
    next_action:terminal(task.state)?'汇报终态；如有产物，读取 get_artifact 后审查。':'立即向用户展示阶段；调用 wait_task 并传 after_event_id=event_cursor，seconds=10。',
  };
}
