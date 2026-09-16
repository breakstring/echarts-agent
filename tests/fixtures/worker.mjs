process.send({ready: true});
process.on('message', job => {
  if (job.option.mode === 'hang') { while (true) {} }
  if (job.option.mode === 'crash') process.exit(2);
  process.send({ok: true, artifact: {mimeType: 'image/svg+xml', svg: JSON.stringify({pid: process.pid, hasSecret: !!process.env.LLM_API_KEY}), width: 1, height: 1, bytes: 1}});
});
