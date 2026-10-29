var p,m,j,te=(f,c)=>{for(var[k,l,g]of p||[])for(var a=[f],n=globalThis,h=n.document,o,e,i,b,d;e=a.pop();)if(!m[e]&&(i=l[e])){m[e]=1;for(b=1;b<i.length;b++)a.push(g[i[b]]);if(!c&&e!==f&&(o=h&&h.head)){if(j===void 0)j=(b=h.querySelector("meta[property=csp-nonce]"))&&(b.nonce||b.getAttribute("nonce"))||"";if(d=h.createElement("link"),d.rel="modulepreload",d.crossOrigin="",j)d.nonce=j;d.href=new n.URL(i[0],k),o.appendChild(d)}}},fn=(f,c,k,l)=>{for(var g={},a=0;a<c.length;a++)g[c[a]]=k[a];(p||=[]).push([f,g,c]),m||={},te(c[l],1)};
export{te,fn};

//# debugId=99BFCE2E074D6E0F64756E2164756E21
