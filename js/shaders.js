// All GPU programs. Pipeline per frame:
//   scene -> (mipmapped, for cheap blur)
//   sim   -> fog field: R fog, G wet film, B pushed water (ridge), A finger-oil memory
//   drops -> height field of running droplets
//   glass -> final composite (fog + refraction + reflections)
window.Mist = window.Mist || {};

Mist.shaders = (() => {
  const VS = `#version 300 es
in vec2 p; out vec2 v;
void main(){ v = p*.5+.5; gl_Position = vec4(p,0.,1.); }`;

  const HEAD = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
`;

  const HASH = `
float hash(vec2 p){ vec3 q=fract(vec3(p.xyx)*.1031); q+=dot(q,q.yzx+33.33); return fract((q.x+q.y)*q.z); }
vec2 hash2(vec2 p){ vec3 q=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); q+=dot(q,q.yzx+33.33); return fract((q.xx+q.yz)*q.zy); }
// mod() can land a hair off an integer on some GPUs, which sends the hash somewhere unrelated and tears the tile.
vec2 wrap(vec2 i,float per){ return floor(i-per*floor((i+.5)/per)+.5); }
`;

  // ---------- Baked once at startup, so per-frame shaders only do texture reads ----------

  const BAKE_NOISE = HEAD + HASH + `
float vn(vec2 p,float per){
  vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  float a=hash(wrap(i,per)),b=hash(wrap(i+vec2(1,0),per)),c=hash(wrap(i+vec2(0,1),per)),d=hash(wrap(i+vec2(1,1),per));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
float fbm(vec2 uv,float per,int n){
  float s=0.,a=.5,t=0.;
  for(int i=0;i<n;i++){ s+=a*vn(uv*per,per); t+=a; a*=.5; per*=2.; uv+=.0; }
  return s/t;
}
void main(){
  o=vec4(fbm(v,4.,5),fbm(v+.37,16.,4),fbm(v+.71,64.,3),hash(floor(v*512.)));
}`;

  // ---------- Fog simulation ----------

  const SIM = HEAD + HASH + `
#define MAXSEG 24
uniform sampler2D uF,uN;
uniform vec2 uTexel;
uniform float uA,uDt,uT,uEvap,uClean,uFrame;
uniform vec4 uBreath[2];         // x,y(aspect space), radius, strength: you, then a rival's pane
uniform float uSplit;
uniform int uSegN;
uniform vec4 uSegA[MAXSEG];      // ax,ay,bx,by
uniform vec4 uSegB[MAXSEG];      // radius, kind (0 finger, 1 fist), memory, seed

// Half floats cannot store tiny per-frame changes near 1.0, so small steps are applied stochastically.
float stoch(float amt,float r){ const float s=.0024; return amt>=s?amt:(r<amt/s?s:0.); }

void main(){
  vec2 q=vec2(v.x*uA,v.y);
  vec4 c=texture(uF,v);
  float f=c.r,wet=c.g,ridge=c.b,mem=c.a;

  float lap=(texture(uF,v+vec2(uTexel.x,0)).r+texture(uF,v-vec2(uTexel.x,0)).r
            +texture(uF,v+vec2(0,uTexel.y)).r+texture(uF,v-vec2(0,uTexel.y)).r)*.25-f;
  f+=lap*min(uDt*.5,.2);

  float r1=hash(gl_FragCoord.xy+uFrame*vec2(1.7,3.1));
  float r2=hash(gl_FragCoord.yx+uFrame*vec2(2.3,.9));

  // Breath: condensation rises toward a target; finger oil makes the glass hold less fog,
  // which is why old drawings reappear when you breathe on them in real life.
  for(int i=0;i<2;i++){
    vec4 B=uBreath[i];
    if(B.w<=.001) continue;
    if(uSplit>.5&&((i==0&&v.x>.5)||(i==1&&v.x<.5))) continue;   // each player fogs only their own side
    float n=texture(uN,q*.55+uT*.012).r;
    float d=length(q-B.xy)/(B.z*(.7+.65*n));
    float g=smoothstep(1.,.2,d);
    float target=mix(1.,.2,smoothstep(.02,.6,mem));
    float rate=B.w*g*(1.-.7*wet)*9.;
    if(f<target) f+=(target-f)*(1.-exp(-rate*uDt));
  }

  // Evaporation: uneven, and thin fog goes first.
  float nE=texture(uN,q*.8+uT*.003).r;
  f-=stoch(uEvap*uDt*(.3+1.5*nE)*(1.3-min(f,1.)),r1);

  wet-=stoch(uDt*.075,r2);
  ridge-=stoch(uDt*.022*(.4+nE),r2);
  mem-=stoch(uDt*.0012,r1);

  // Touch strokes as capsules.
  for(int i=0;i<uSegN;i++){
    vec4 A=uSegA[i],P=uSegB[i];
    vec2 a=A.xy,ba=A.zw-a,pa=q-a;
    float R=P.x,L2=dot(ba,ba);
    float t=L2>1e-9?clamp(dot(pa,ba)/L2,0.,1.):0.;
    vec2 cl=pa-ba*t;
    float d=length(cl);
    if(d>R*1.7) continue;
    vec2 dir=L2>1e-9?ba/sqrt(L2):vec2(0,1);
    float s=dot(cl,vec2(-dir.y,dir.x))/R;              // position across the stroke

    // Crisp, even edge: a clean line, not a ragged one. The soft band stays a constant
    // width so thin lines keep their definition.
    float wob=(texture(uN,q*2.6).g-.5)*R*.05;
    float soft=max(R*.2,.0016);
    float mask=1.-smoothstep(R-soft,R,d+wob);
    float streak=texture(uN,vec2(s*.11+P.w,P.w*.7)).b;
    float residue=0.;
    if(P.y>.5){
      // Fist: a few faint streaks along the wipe, the way skin leaves them.
      residue=smoothstep(.56,.76,streak)*.09;
    }
    float before=f;
    f*=1.-mask*(1.-residue);
    wet=max(wet,mask*(.75+.25*streak));
    mem=max(mem,mask*P.z);
    float rim=smoothstep(R*1.5,R,d)*(1.-smoothstep(R*.96,R*1.02,d));
    ridge=min(ridge+rim*before*.05,1.);
  }

  if(uClean>0.){
    float k=1.-uClean;
    f*=k; ridge*=k; mem*=k; wet*=k;
  }
  if(f<.002) f=0.;
  o=vec4(clamp(f,0.,1.15),max(wet,0.),max(ridge,0.),max(mem,0.));
}`;

  // Droplet trails multiply fog away (blend ZERO, SRC_COLOR).
  const POINT_VS = `#version 300 es
in vec4 a; out float vS; out float vZ;
void main(){ gl_Position=vec4(a.xy*2.-1.,0.,1.); gl_PointSize=a.z; vS=a.w; vZ=a.z; }`;

  const CARVE = `#version 300 es
precision highp float;
out vec4 o;
void main(){
  vec2 p=gl_PointCoord*2.-1.;
  float m=1.-smoothstep(.55,1.,length(p));
  o=vec4(1.-m,1.,1.,1.);
}`;

  const DROP = `#version 300 es
precision highp float;
in float vS; in float vZ; out vec4 o;
void main(){
  vec2 p=(gl_PointCoord*2.-1.)*vec2(1.,-1.);
  float s=1.+vS; p*=s;
  float top=max(p.y,0.);
  float yy=p.y>0.?p.y/(1.+vS*.9):p.y;
  float xx=p.x/max(.25,1.-.55*vS*clamp(top/s,0.,1.));
  float d=xx*xx+yy*yy;
  if(d>=1.) discard;
  o=vec4(sqrt(1.-d)*clamp(vZ/26.,.45,1.),0.,0.,1.);
}`;

  // ---------- What is behind the glass ----------

  const SCENE_HEAD = HEAD + HASH + `uniform float uT,uA; uniform sampler2D uN;\n`;

  const CITY = SCENE_HEAD + `
vec3 pal(float h){
  if(h<.42) return vec3(1.,.62,.24);
  if(h<.62) return vec3(1.,.36,.30);
  if(h<.78) return vec3(.98,.86,.66);
  if(h<.91) return vec3(.26,.74,.86);
  return vec3(.78,.40,.96);
}
void main(){
  vec2 q=vec2(v.x*uA,v.y);
  vec3 c=mix(vec3(.17,.075,.2),vec3(.035,.055,.13),smoothstep(.0,.9,v.y));
  c+=vec3(.34,.11,.06)*pow(1.-v.y,3.2);
  for(int L=0;L<3;L++){
    float s=float(L), g=mix(4.2,10.5,s/2.);
    vec2 P=q*g+vec2(s*7.31+uT*.012*(s-1.),s*3.1);
    vec2 id=floor(P);
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
      vec2 cid=id+vec2(x,y);
      vec2 h=hash2(cid+s*17.3);
      float wy=(cid.y+h.y-s*3.1)/g;
      float dens=mix(.78,.2,smoothstep(.12,.9,wy));
      if(hash(cid*1.71+s)>dens) continue;
      float r=mix(.2,.47,hash(cid+3.3));
      float d=length(P-cid-h);
      float disc=smoothstep(r,r-.035,d)*(.5+.5*smoothstep(0.,r,d));
      float tw=.62+.38*sin(uT*(.25+h.x*.7)+h.y*6.28);
      c+=pal(hash(cid*2.3+s))*disc*tw*mix(.85,.34,s/2.);
    }
  }
  o=vec4(c,1.);
}`;

  const DUSK = SCENE_HEAD + `
void main(){
  vec2 q=vec2(v.x*uA,v.y);
  vec3 c=mix(vec3(1.,.66,.38),vec3(.48,.34,.56),smoothstep(.2,.68,v.y));
  c=mix(c,vec3(.13,.17,.38),smoothstep(.58,1.05,v.y));
  vec2 sun=vec2(uA*.63,.40);
  float d=length(q-sun);
  c+=vec3(1.,.70,.40)*(.62*exp(-d*3.1)+.95*smoothstep(.058,.05,d));
  float n=texture(uN,q*vec2(.32,1.25)+vec2(uT*.0022,0.)).r;
  c+=vec3(1.,.55,.5)*smoothstep(.5,.74,n)*.24*smoothstep(.36,.6,v.y)*(1.-smoothstep(.72,1.,v.y));
  for(int i=0;i<4;i++){
    float t=float(i)/3.;
    float base=mix(.42,.13,t);
    float x=q.x*(.2+.13*t)+t*.41;
    float h=base+.17*(texture(uN,vec2(x,.31+t*.2)).r-.5)+.022*(texture(uN,vec2(x*4.,.7+t*.2)).g-.5);
    vec3 col=mix(vec3(.72,.40,.42),vec3(.075,.07,.16),pow(t,.8));
    c=mix(c,col,smoothstep(h+.0018,h-.0018,v.y));
  }
  o=vec4(c,1.);
}`;

  const AURORA = SCENE_HEAD + `
void main(){
  vec2 q=vec2(v.x*uA,v.y);
  vec3 c=mix(vec3(.018,.07,.10),vec3(.006,.012,.04),smoothstep(.1,.95,v.y));
  vec2 g=q*90.,id=floor(g);
  float st=hash(id);
  if(st>.965){
    vec2 h=hash2(id);
    float tw=.65+.35*sin(uT*(.5+h.x*2.)+h.y*6.28);
    c+=vec3(.86,.93,1.)*smoothstep(.14,.0,length(fract(g)-h))*tw*(st-.965)*28.;
  }
  for(int i=0;i<6;i++){
    float f=float(i)/5.;
    float w=texture(uN,vec2(q.x*.3+f*.61+uT*.0045,f*.3)).r;
    float yb=.5+f*.11+(w-.5)*.46;
    float dy=v.y-yb;
    float cur=exp(-max(dy,0.)*mix(8.,3.6,f))*smoothstep(-.025,.012,dy);
    float rays=.42+.85*texture(uN,vec2(q.x*1.9+f*.77+uT*.0065,.13)).g;
    c+=mix(vec3(.10,.95,.58),vec3(.56,.26,.95),f*f)*cur*rays*.34;
  }
  // Snow hills and pines, far to near.
  for(int L=0;L<3;L++){
    float s=float(L), t=s/2.;
    float hg=mix(.27,.09,t)+mix(.07,.045,t)*(texture(uN,vec2(q.x*.17+s*.31,.4+s*.17)).r-.5)*2.;
    vec3 snow=mix(vec3(.17,.27,.33),vec3(.075,.125,.17),t);
    vec3 pine=mix(vec3(.05,.1,.125),vec3(.008,.02,.032),t);
    float cells=mix(26.,8.,t);
    float X=q.x*cells+s*5.3;
    for(int k=-1;k<=1;k++){
      float cx=floor(X)+float(k);
      if(hash(vec2(cx,s+7.))>.62) continue;
      float H=mix(.05,.1,hash(vec2(cx,s)))*mix(1.,2.3,t);
      float off=(hash(vec2(cx,s+3.))-.5)*.5;
      float dx=abs(X-cx-.5-off)/cells;
      float y=(v.y-hg+.012)/H;
      if(y<0.||y>1.) continue;
      float tier=1.-.3*fract(y*4.);
      float w=(1.-y)*H*.27*tier;
      c=mix(c,pine,smoothstep(w+.0012,w-.0012,dx));
    }
    c=mix(c,snow,smoothstep(hg+.0016,hg-.0016,v.y));
  }
  o=vec4(c,1.);
}`;

  const VIDEO = HEAD + `
uniform sampler2D uV; uniform vec2 uCover; uniform float uFlip,uDim;
void main(){
  vec2 uv=(v-.5)*uCover+.5;
  uv.y=1.-uv.y;
  if(uFlip>.5) uv.x=1.-uv.x;
  vec3 c=texture(uV,uv).rgb*uDim;
  o=vec4(pow(c,vec3(.9)),1.);
}`;

  const COPY = HEAD + `uniform sampler2D uS; void main(){ o=texture(uS,v); }`;

  // ---------- Blur chain ----------
  // Dual filter: a few small down and up passes give a wide, silky blur with no grain,
  // far cheaper than one big kernel.
  const DOWN = HEAD + `uniform sampler2D uS; uniform vec2 uTx;
void main(){
  vec3 c=texture(uS,v).rgb*4.;
  c+=texture(uS,v+uTx*vec2(1,1)).rgb+texture(uS,v+uTx*vec2(-1,1)).rgb+texture(uS,v+uTx*vec2(1,-1)).rgb+texture(uS,v+uTx*vec2(-1,-1)).rgb;
  o=vec4(c/8.,1.);
}`;

  const UP = HEAD + `uniform sampler2D uS; uniform vec2 uTx;
void main(){
  vec3 c=texture(uS,v+uTx*vec2(-2,0)).rgb+texture(uS,v+uTx*vec2(2,0)).rgb+texture(uS,v+uTx*vec2(0,-2)).rgb+texture(uS,v+uTx*vec2(0,2)).rgb;
  c+=2.*(texture(uS,v+uTx*vec2(-1,1)).rgb+texture(uS,v+uTx*vec2(1,1)).rgb+texture(uS,v+uTx*vec2(-1,-1)).rgb+texture(uS,v+uTx*vec2(1,-1)).rgb);
  o=vec4(c/12.,1.);
}`;

  // ---------- The glass ----------

  const GLASS = HEAD + `
uniform sampler2D uS,uBlur,uMid,uF,uD,uN;
uniform vec2 uRes,uFTexel,uLook;
uniform vec3 uTip[2];        // fingertip position (aspect space) and how close it is
uniform float uA,uFade;

float ign(vec2 p){ return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715)))); }

void main(){
  vec2 uv=v, q=vec2(uv.x*uA,uv.y);
  float grain=ign(gl_FragCoord.xy);

  vec4 F=texture(uF,uv);
  float f=F.r,wet=F.g,ridge=F.b;

  vec2 e=uFTexel*1.25;
  vec2 gF=vec2(texture(uF,uv+vec2(e.x,0)).r-texture(uF,uv-vec2(e.x,0)).r,
               texture(uF,uv+vec2(0,e.y)).r-texture(uF,uv-vec2(0,e.y)).r);
  float slope=length(gF);

  // Density is smooth: fog thins evenly, like a real veil.
  float a=smoothstep(.02,.56,f);
  float veil=smoothstep(.12,.8,f);

  // A thin water film bends what is seen through a wiped path, very slightly.
  vec2 film=(texture(uN,q*vec2(1.5,.5)).gb-.5)*wet*.0028;
  vec2 ref=film-gF*.012;

  vec3 clear=texture(uS,uv+ref).rgb;

  // Frosted glass shows things touching it more sharply. So a fingertip near the glass reads
  // clearly through the fog, which is what lets you aim.
  float contact=0.;
  for(int i=0;i<2;i++){
    vec2 dt=q-uTip[i].xy;
    contact=max(contact,uTip[i].z*exp(-dot(dt,dt)/.011));
  }
  vec3 heavy=texture(uBlur,uv).rgb;
  vec3 mid=texture(uMid,uv).rgb;
  vec3 blurred=mix(heavy,mid,contact*.62);

  // Water scatters light: a pale, luminous veil tinted by what is behind it.
  vec3 glow=heavy*.36+vec3(.33,.355,.395);
  vec3 milk=1.-(1.-blurred*.9)*(1.-glow);

  vec3 col=mix(clear,blurred,smoothstep(0.,.5,a));
  col=mix(col,milk,a*mix(.62,.95,veil)*(1.-contact*.2));

  // Polished edge on every stroke: a thin meniscus, lit from above.
  vec2 Lxy=normalize(vec2(-.42,.9));
  float bevel=dot(gF,Lxy);
  col+=clamp(bevel*.42,-.035,.1)*(.55+dot(heavy,vec3(.33)));
  col+=ridge*.03;

  // Wet path: a faint gloss, not a texture.
  col+=wet*(1.-a)*.012;

  // Running droplets: tiny inverted lenses with one clean highlight.
  vec2 px=1./uRes;
  float h=texture(uD,uv).r;
  if(h>.004){
    vec2 n=vec2(texture(uD,uv+vec2(px.x*1.5,0)).r-texture(uD,uv-vec2(px.x*1.5,0)).r,
                texture(uD,uv+vec2(0,px.y*1.5)).r-texture(uD,uv-vec2(0,px.y*1.5)).r);
    float m=smoothstep(.004,.09,h);
    vec2 lensN=n*2.;
    vec3 N=normalize(vec3(-lensN*2.1,max(h,.08)));
    vec3 inv=texture(uS,uv-lensN*.07).rgb*1.12+heavy*.2+.03;
    inv*=mix(.74,1.,smoothstep(.0,.4,h));
    col=mix(col,inv,m);
    vec3 L=normalize(vec3(-.36+uLook.x*.4,.62+uLook.y*.4,.7));
    col+=m*pow(max(dot(N,L),0.),46.)*.95*smoothstep(.35,.85,h);
  }

  col*=uFade;

  // Glass surface on top of everything: soft reflections that drift as you move.
  vec2 pr=uv+uLook*.02;
  float k=pr.x*.72+pr.y*.62;
  float win=smoothstep(.42,.74,k)*(1.-smoothstep(.76,1.02,k));
  float streak=exp(-pow((k-.31)*7.,2.))*.5;
  float sky=pow(clamp(pr.y,0.,1.),2.4)*.34;
  float refl=(win*.09+streak*.07+sky*.06)*mix(1.,.45,a);
  col=1.-(1.-col)*(1.-refl*vec3(.88,.94,1.));

  // Bevelled edge.
  vec2 dE=min(uv,1.-uv)*vec2(uA,1.);
  float de=min(dE.x,dE.y);
  col*=mix(.8,1.,smoothstep(-.05,.5,de));
  float rim=exp(-de*uRes.y*.14);
  float light=.45+.55*dot(normalize(uv-.5+1e-4),normalize(vec2(-.5,.8)));
  col+=rim*max(light,0.)*vec3(.18,.2,.23);
  col*=1.-exp(-de*uRes.y*.75)*.7;

  // Soft shoulder so highlights roll off, and only enough dither to prevent banding.
  col=col*(1.+col*.12)/(1.+col*.26)*1.08;
  col+=(grain-.5)/255.*1.2;
  o=vec4(col,1.);
}`;

  return { VS, BAKE_NOISE, SIM, POINT_VS, CARVE, DROP, CITY, DUSK, AURORA, VIDEO, COPY, DOWN, UP, GLASS };
})();
