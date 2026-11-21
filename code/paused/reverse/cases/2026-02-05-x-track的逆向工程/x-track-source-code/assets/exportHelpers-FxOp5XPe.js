const c=async o=>{try{return await navigator.clipboard.writeText(o),!0}catch(n){return console.error("Failed to copy:",n),!1}},l=o=>{const n=`# Tweet by @${o.handle}

**Author:** ${o.author}  
**Handle:** @${o.handle}  
**Posted:** ${new Date(o.timestamp).toLocaleString()}  
**Tweet ID:** ${o.id}

## Content

${o.content}

## Stats

- 👁️ Views: ${o.views||0}
- ❤️ Likes: ${o.likes||0}
- 🔄 Retweets: ${o.retweets||0}
- 💬 Replies: ${o.replies||0}

${o.media&&o.media.length>0?`## Media

${o.media.map((r,d)=>`${d+1}. [${r.type}](${r.url})`).join(`
`)}
`:""}
---
*Exported from X-Track on ${new Date().toLocaleString()}*
`,a=new Blob([n],{type:"text/markdown"}),t=URL.createObjectURL(a),e=document.createElement("a");e.href=t,e.download=`tweet_${o.id}_${o.handle}.md`,document.body.appendChild(e),e.click(),document.body.removeChild(e),URL.revokeObjectURL(t)},i=o=>{const n=JSON.stringify(o,null,2),a=new Blob([n],{type:"application/json"}),t=URL.createObjectURL(a),e=document.createElement("a");e.href=t,e.download=`tweet_${o.id}_${o.handle}.json`,document.body.appendChild(e),e.click(),document.body.removeChild(e),URL.revokeObjectURL(t)};export{c as copyToClipboard,i as exportToJSON,l as exportToMarkdown};
