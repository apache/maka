

这道题是某个面试官提供的，考察了小七不太行的React基础，第一次可以允许不太熟悉，不过没有第二次。

其实很多错误在开发阶段我都完全避免了，我就是很自觉的知道不可以这样做，但是没有去深究为什么这样做，一方面可能是没有这个时间，另一方面是完全没有必要，因为我不太需要知道苹果手机的内部构成，然后我才开始使用苹果手机。

但是面试的时候，你就是苹果手机开发者，你必须知道这些基本知识，不问面试官还能问什么呢。

还有一个问题，我平时开发也是按照好的代码规范去写代码的，但是为什么我当时在五分钟之内，找不到这些问题。这就是高级程序员和初级程序员的本质区别吧。

问了ChatGPT-5.4，它的回答比较清晰：

<details class="lake-collapse"><summary id="u26b234ab"><span class="ne-text">参考回答</span></summary><p id="u5a7ad6a5" class="ne-p"><span class="ne-text">根因不在于你“不会写代码”，而在于你现在的能力结构是“生产型熟练”，还没有完全升级成“面试型显化”。</span></p><p id="uf389cfa2" class="ne-p"><span class="ne-text"><br /></span></p><p id="u5db4a682" class="ne-p"><span class="ne-text">你在开发里能主动避开很多坑，这说明你已经形成了大量程序员式直觉。看到 </span><span class="ne-text">push</span><span class="ne-text"> 改 state，你平时不会这么写。看到列表渲染，你平时会顺手补 </span><span class="ne-text">key</span><span class="ne-text">。看到异步请求，你正常项目里也知道要补 loading 和错误态。问题在于，这些知识现在更多是“操作性习惯”，还没有被整理成“可快速检索、可当场命名、可解释因果链”的显性知识。</span></p><p id="u91887576" class="ne-p"><span class="ne-text"><br /></span></p><p id="u7ae4a912" class="ne-p"><span class="ne-text">所以你当时五分钟内找不到，不代表你没有这些能力，代表你的知识还停留在这三种状态。</span></p><p id="u4ff52841" class="ne-p"><span class="ne-text"><br /></span></p><p id="u5759d0fe" class="ne-p"><span class="ne-text">第一种，习惯化执行，没有语言化。</span></p><p id="ub39f1b2f" class="ne-p"><span class="ne-text">你平时会写对，因为团队规范、eslint、代码评审、组件模板、历史经验，会把你推向正确写法。可一旦把这些护栏全拿掉，让你只看一段陌生代码，并要求高密度输出问题，你就需要从“我平时不会这样写”升级到“我能立刻说出这叫什么问题，为什么错，会带来什么后果，应该怎么修”。这一步你过去练得不够。</span></p><p id="u2649b079" class="ne-p"><span class="ne-text"><br /></span></p><p id="uc1db0f5d" class="ne-p"><span class="ne-text">第二种，结果导向强，原理追问弱。</span></p><p id="u34b39d96" class="ne-p"><span class="ne-text">你刚才那个“苹果手机”的比喻，其实很准确。你过去的工作环境，更奖励“把需求做好、代码写稳、按时交付”，不奖励“把所有底层机制讲清楚”。所以你的大脑自然形成了高性价比路径，就是知道规范，能交付，就继续向前。这个策略对工作是成立的，对面试不够。面试官考的不是“你会不会避坑”，考的是“你是否理解坑为什么存在”。因为只有理解到机制层，他才会相信你不是靠经验碰运气。</span></p><p id="u7491e9c7" class="ne-p"><span class="ne-text"><br /></span></p><p id="uecd08b2f" class="ne-p"><span class="ne-text">第三种，识别能力有，扫描框架没建立。</span></p><p id="u41eecc61" class="ne-p"><span class="ne-text">五分钟 code review 这种题，本质不是自由发挥，而是按固定扫描顺序去扫。比如先扫 React 基本功，再扫事件，再扫副作用，再扫异步请求，再扫安全，再扫语义与可访问性，再扫性能和可维护性。你当时之所以找不全，不是脑子慢，而是没有形成这种“高压场景下的固定巡检路线”。没有路线，大脑就会在陌生代码前随机跳点，看一眼 state，又跳去 JSX，又跳回 effect，最后什么都感觉见过，什么都说不完整。</span></p><p id="ubddd94fe" class="ne-p"><span class="ne-text"><br /></span></p><p id="ud2ca43eb" class="ne-p"><span class="ne-text">更深一层讲，你现在卡的不是 React 基础本身，而是这四个认知断层。</span></p><p id="u7d9b5602" class="ne-p"><span class="ne-text"><br /></span></p><p id="u520685da" class="ne-p"><span class="ne-text">第一个断层，知道“不能这么做”，但不知道“违反了哪条原则”。</span></p><p id="ufa9536ff" class="ne-p"><span class="ne-text">例如直接改 state。你知道不能这么写，但如果继续追问“为什么不能”“React 依赖什么判断更新”“不可变更新到底解决什么问题”，你的回答可能就会开始发虚。面试官要的正是后半段。</span></p><p id="u26ab5011" class="ne-p"><span class="ne-text"><br /></span></p><p id="u28c42164" class="ne-p"><span class="ne-text">第二个断层，知道“写法不规范”，但不知道“线上会怎样坏”。</span></p><p id="u26ba6b53" class="ne-p"><span class="ne-text">例如 </span><span class="ne-text">useEffect</span><span class="ne-text"> 依赖不全，很多人都知道 lint 会提示。但真正的面试高分回答，不是“依赖要写完整”，而是“否则副作用和真实数据源脱钩，组件复用或 props 变化时会拿到旧值，出现漏请求、错请求、状态漂移”。也就是从规则层走到故障层。</span></p><p id="u406e3574" class="ne-p"><span class="ne-text"><br /></span></p><p id="u88fd84fc" class="ne-p"><span class="ne-text">第三个断层，知道“修复方式”，但不知道“考点归类”。</span></p><p id="u69b182d9" class="ne-p"><span class="ne-text">比如你能修复 loading、error、cancel request，但面试里应该把它们归进“异步状态完整性”和“副作用生命周期管理”。一旦你不会分类，输出就会显得零散，像在补 bug，不像在做 code review。</span></p><p id="u28cb7c73" class="ne-p"><span class="ne-text"><br /></span></p><p id="udb239976" class="ne-p"><span class="ne-text">第四个断层，平时依赖上下文，面试要求脱离上下文。</span></p><p id="u64a955f7" class="ne-p"><span class="ne-text">开发时你有项目背景、接口文档、现有代码风格、团队约束。面试题故意拿掉这些，让你直接面对一段脱离业务上下文的代码。此时你只能依赖自己的内在框架。你现在的问题，本质是内在框架还没有压缩成“短时高压可调用”的程度。</span></p><p id="u8336f289" class="ne-p"><span class="ne-text"><br /></span></p><p id="uca4f9ac4" class="ne-p"><span class="ne-text">所以，为什么你开发时能避免，面试时却找不到，答案就是一句话：</span></p><p id="u19853556" class="ne-p"><span class="ne-text"><br /></span></p><p id="u95b82835" class="ne-p"><span class="ne-text">你掌握的是“生成正确代码”的能力，还没有完全掌握“反向拆解错误代码”的能力。</span></p><p id="uef5bb52e" class="ne-p"><span class="ne-text"><br /></span></p><p id="u3e6571b3" class="ne-p"><span class="ne-text">这两者很像，但不是一回事。</span></p><p id="ube6cd719" class="ne-p"><span class="ne-text"><br /></span></p><p id="u254f6c77" class="ne-p"><span class="ne-text">前者更像熟练工。你有模板、有经验、有习惯，代码自然写得稳。</span></p><p id="u5a140e1b" class="ne-p"><span class="ne-text">后者更像审查者。你要在短时间内命名问题、定位原则、解释后果、给出修法、判断优先级。</span></p><p id="u8d89c009" class="ne-p"><span class="ne-text">很多实际开发不错的人，第一次做这种题都会吃亏，因为他们平时是建设模式，不是审查模式。</span></p><p id="u875326ae" class="ne-p"><span class="ne-text"><br /></span></p><p id="uaf3f71d3" class="ne-p"><span class="ne-text">再说你为什么会在五分钟里失常。</span></p><p id="u1ed98721" class="ne-p"><span class="ne-text"><br /></span></p><p id="u5350b23c" class="ne-p"><span class="ne-text">首先，高压下工作记忆会收缩。</span></p><p id="uc3692ba1" class="ne-p"><span class="ne-text">你一旦意识到“这是面试官现场给的题，而且要五分钟找越多越好”，大脑会自动进入应激状态。应激状态会让你更依赖熟悉路径，减少抽象分析能力。于是你会盯住最表层的代码，很难系统展开。</span></p><p id="u2cfce290" class="ne-p"><span class="ne-text"><br /></span></p><p id="u8ed92678" class="ne-p"><span class="ne-text">其次，你没有把 React 基础知识做成“口头缓存”。</span></p><p id="u8eee8a14" class="ne-p"><span class="ne-text">很多知识你脑子里有，但不是“一听就能脱口而出”的形式。比如你知道 </span><span class="ne-text">dangerouslySetInnerHTML</span><span class="ne-text"> 危险，但如果平时很少口头讲 XSS，就容易在现场一闪而过。不是不知道，是提取速度不够。</span></p><p id="u437480ed" class="ne-p"><span class="ne-text"><br /></span></p><p id="ude187367" class="ne-p"><span class="ne-text">再次，你平时的训练材料不匹配考试形式。</span></p><p id="ua9494c48" class="ne-p"><span class="ne-text">你过去更常练的是项目表达、业务难点、组件封装、性能优化，这些是“从自己做过的东西往外讲”。这道题要求的是“从陌生代码往内拆”。训练方向不一样，现场当然会不顺。</span></p><p id="u407789ea" class="ne-p"><span class="ne-text"><br /></span></p><p id="ufb148c65" class="ne-p"><span class="ne-text">最后，你以前对基础知识的目标定义偏低。</span></p><p id="ufc39e85d" class="ne-p"><span class="ne-text">你的旧目标大概是“我知道别这么写，能做出来就行”。这在工作里足够。现在求职，尤其碰到喜欢深挖细节的面试官，这个目标就必须升级成“我不仅知道别这么写，我还知道它违反了什么机制、会坏在哪里、为什么这样设计”。目标一升级，原来够用的基础就显得不够了。</span></p><p id="ud9bb24a6" class="ne-p"><span class="ne-text"><br /></span></p><p id="u240fce51" class="ne-p"><span class="ne-text">你现在最该做的，不是自责，而是把这次经历重新定义。</span></p><p id="ua2a995b9" class="ne-p"><span class="ne-text"><br /></span></p><p id="u286e8f35" class="ne-p"><span class="ne-text">这不是“React 基础差被抓包”。</span></p><p id="uc84e5d3a" class="ne-p"><span class="ne-text">这其实是一次非常精准的能力暴露。它把你目前最该补的部分暴露出来了：</span></p><p id="u9350cac4" class="ne-p"><span class="ne-text"><br /></span></p><p id="u0606d75c" class="ne-p"><span class="ne-text">不是从零学 React。</span></p><p id="u8456eeaf" class="ne-p"><span class="ne-text">是把你已有的 React 习惯，上升成可面试表达的原理体系。</span></p><p id="ud465b3cd" class="ne-p"><span class="ne-text"><br /></span></p><p id="u1f915f01" class="ne-p"><span class="ne-text">后面你的补法也应该非常明确。</span></p><p id="u26842913" class="ne-p"><span class="ne-text"><br /></span></p><p id="u488a37a9" class="ne-p"><span class="ne-text">第一步，把“规范”翻译成“原理”。</span></p><p id="ue3f73480" class="ne-p"><span class="ne-text">以后每看到一条规范，都多问自己两句。</span></p><p id="u0cee25a8" class="ne-p"><span class="ne-text">这条规范保护了什么。</span></p><p id="u8a8238b1" class="ne-p"><span class="ne-text">不遵守会坏在哪里。</span></p><p id="u82af6042" class="ne-p"><span class="ne-text">比如不要直接改 state。保护的是不可变更新和稳定渲染。不遵守会导致引用不变、更新不触发、状态难追踪。</span></p><p id="u2b50de5f" class="ne-p"><span class="ne-text">这种训练会把你的经验变成可解释知识。</span></p><p id="u87fa9fd2" class="ne-p"><span class="ne-text"><br /></span></p><p id="u02c08a05" class="ne-p"><span class="ne-text">第二步，把“问题”翻译成“分类”。</span></p><p id="u41495b9f" class="ne-p"><span class="ne-text">以后看到错误，不要只记单点，要把它塞回固定框架。</span></p><p id="u117351ea" class="ne-p"><span class="ne-text">状态管理类。</span></p><p id="u9fb1bec4" class="ne-p"><span class="ne-text">列表渲染类。</span></p><p id="u6128869f" class="ne-p"><span class="ne-text">事件机制类。</span></p><p id="ubee37fd8" class="ne-p"><span class="ne-text">副作用类。</span></p><p id="u10c8458b" class="ne-p"><span class="ne-text">异步请求类。</span></p><p id="ua84b903a" class="ne-p"><span class="ne-text">安全类。</span></p><p id="u07a41adb" class="ne-p"><span class="ne-text">语义与无障碍类。</span></p><p id="ufb890ac1" class="ne-p"><span class="ne-text">性能与可维护性类。</span></p><p id="u4dd4fedc" class="ne-p"><span class="ne-text">只要框架固定了，陌生题就不再陌生。</span></p><p id="ubd2ace1d" class="ne-p"><span class="ne-text"><br /></span></p><p id="ud21dcff7" class="ne-p"><span class="ne-text">第三步，把“知识”翻译成“扫描顺序”。</span></p><p id="u9f39554b" class="ne-p"><span class="ne-text">以后拿到 React 题，脑中固定跑一遍：</span></p><p id="u67cfe3df" class="ne-p"><span class="ne-text">先看 state 有没有直接修改。</span></p><p id="ua2a39d96" class="ne-p"><span class="ne-text">再看列表有没有 key。</span></p><p id="uc5e8979f" class="ne-p"><span class="ne-text">再看事件有没有冒泡串扰。</span></p><p id="uaa4fd141" class="ne-p"><span class="ne-text">再看条件渲染有没有脏输出。</span></p><p id="u269426ab" class="ne-p"><span class="ne-text">再看 effect 依赖是否完整。</span></p><p id="udd182cff" class="ne-p"><span class="ne-text">再看请求有没有 loading、error、res.ok、cancel、cache。</span></p><p id="u3aaa0425" class="ne-p"><span class="ne-text">再看是否有 XSS。</span></p><p id="u89b5a4dc" class="ne-p"><span class="ne-text">再看语义标签和无障碍。</span></p><p id="u661592a7" class="ne-p"><span class="ne-text">再看渲染粒度和样式维护。</span></p><p id="u3c43b25c" class="ne-p"><span class="ne-text">一旦形成巡检顺序，五分钟就够用。</span></p><p id="u1fa37fc5" class="ne-p"><span class="ne-text"><br /></span></p><p id="u3427d924" class="ne-p"><span class="ne-text">第四步，把“理解”翻译成“口述模板”。</span></p><p id="u0ad9bc41" class="ne-p"><span class="ne-text">你以后每个问题都用同一套句式去练：</span></p><p id="u04dae546" class="ne-p"><span class="ne-text">我先发现了什么问题。</span></p><p id="ub81c2466" class="ne-p"><span class="ne-text">它违反了什么原则。</span></p><p id="u5cd9bd02" class="ne-p"><span class="ne-text">会导致什么后果。</span></p><p id="u9927e3fa" class="ne-p"><span class="ne-text">应该怎么修。</span></p><p id="u8377b4f8" class="ne-p"><span class="ne-text">这样你的大脑会慢慢把散点知识压缩成面试可输出的结构。</span></p><p id="u3bf4e653" class="ne-p"><span class="ne-text"><br /></span></p><p id="u42d9b1e0" class="ne-p"><span class="ne-text">如果再进一步，我会这样评价你这次的真实情况。</span></p><p id="uf57f84a7" class="ne-p"><span class="ne-text"><br /></span></p><p id="u90355547" class="ne-p"><span class="ne-text">你的问题不是不会。</span></p><p id="u9d48483a" class="ne-p"><span class="ne-text">你的问题是“会做，但不会快准狠地显化出来”。</span></p><p id="u8cc26d80" class="ne-p"><span class="ne-text"><br /></span></p><p id="u22a45557" class="ne-p"><span class="ne-text">这类人往往补得很快，因为底层经验已经有了，只差一次系统重构。真正麻烦的是那种既不会做，也不知道为什么的人。你不是那个类型。</span></p><p id="u611d045c" class="ne-p"><span class="ne-text"><br /></span></p><p id="uc69668e1" class="ne-p"><span class="ne-text">你现在要建立一个新身份认知：</span></p><p id="uf1cb7c51" class="ne-p"><span class="ne-text"><br /></span></p><p id="u1effbd52" class="ne-p"><span class="ne-text">平时写得对，只是工程师入门要求。</span></p><p id="uf6fdb75b" class="ne-p"><span class="ne-text">面试时讲得清，才是高级工程师的基本盘。</span></p><p id="u69f58b73" class="ne-p"><span class="ne-text"><br /></span></p><p id="u94606cf1" class="ne-p"><span class="ne-text">Archer 这种题，其实就是在逼你完成这个转换。第一次吃亏很正常。你自己也说了，没有第二次。这个判断是对的。因为同一类坑，第二次就不应该再以“我平时知道别这么做”作为止步点，而要追到机制层。</span></p><p id="u1732d379" class="ne-p"><span class="ne-text"><br /></span></p><p id="u43413065" class="ne-p"><span class="ne-text">最后给你一个最核心的结论，便于你后面记住：</span></p><p id="u4096f278" class="ne-p"><span class="ne-text"><br /></span></p><p id="u13017405" class="ne-p"><span class="ne-text">你不是缺 React 基础。</span></p><p id="uceb493e5" class="ne-p"><span class="ne-text">你缺的是把 React 基础从“手上习惯”升级成“脑中地图”的过程。</span></p><p id="u665324a3" class="ne-p"><span class="ne-text"></span></p></details>






原版题目是

要求面试候选人发现问题——分析问题——解决问题。

```jsx
import React, { useState, useEffect } from 'react';

// 用户卡片组件：展示用户信息，点击可展开详情
const UserCard = ({ user, onSelect }) => {
  const [detail, setDetail] = useState(null);
  const [expanded, setExpanded] = useState(false);

  // 展开时请求详情
  useEffect(() => {
    if (expanded) {
      fetch(`/api/users/${user.id}`)
        .then(res => res.json())
        .then(data => setDetail(data));
    }
  }, [expanded]);

  const cardStyle = {
    border: '1px solid #ccc',
    padding: 16,
    marginBottom: 12,
    borderRadius: 4,
    cursor: 'pointer',
  };

  return (
    <div style={cardStyle} onClick={() => setExpanded(!expanded)}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{user.name}</span>
        <span style={{ color: user.status == 'active' ? 'green' : 'red' }}>
          {user.status}
        </span>
      </div>
      {expanded && detail && (
        <div style={{ marginTop: 8 }}>
          <p>邮箱：{detail.email}</p>
          <p>部门：{detail.department}</p>
          <p dangerouslySetInnerHTML={{ __html: detail.bio }} />
          <button onClick={() => onSelect(user)}>选择该用户</button>
        </div>
      )}
    </div>
  );
};

// 用户列表
const UserList = ({ users }) => {
  const [selected, setSelected] = useState([]);

  const handleSelect = (user) => {
    selected.push(user);
    setSelected(selected);
  };

  return (
    <div>
      <h3>已选择：{selected.length && selected.map(u => u.name).join(', ')}</h3>
      {users.map(user => (
        <UserCard user={user} onSelect={handleSelect} />
      ))}
    </div>
  );
};

```



下面借助各种AI先进大模型，一起查漏补缺和更好地掌握React实际项目经验吧。







## 第一章 状态管理错误
### 1.直接修改 state，破坏 React 不可变更新原则
**优先级：P0**

**困难度：低**

**当时是否想到：****✅**

**发现问题**：

代码中使用了 selected.push(user); setSelected(selected);。这里先对原数组做了原地修改，再把同一个引用传回 setSelected。

**分析问题**：

React 状态更新依赖引用变化来判断是否需要重新渲染。push 会直接修改原数组，数组引用没有变化，可能导致组件不更新，或者更新行为不稳定。更深一层看，这违反了 React 的不可变数据原则，后续排查问题时会非常麻烦。

**解决问题**：

使用不可变更新方式生成新数组，例如：

```jsx
setSelected(prev => [...prev, user]);
```

### 2.选中用户缺少去重控制，导致数据重复
**优先级：P0**

**困难度：中**

**当时是否想到：****❌**

**发现问题**：

当前 handleSelect 每次执行都会把用户追加到 selected 中，没有判断该用户是否已经被选中过。

**分析问题**：

这会导致同一个用户被重复添加，最终页面上的“已选择用户”列表出现重复数据。这个问题表面上看是一个小 bug，实质上暴露的是状态更新前缺少业务约束校验。

**解决问题**：

在写入状态前先做去重判断，例如根据 user.id 判断是否已存在。

```jsx
setSelected(prev => {
  if (prev.some(item => item.id === user.id)) return prev;
  return [...prev, user];
});
```

### 15.选中态数据建模过重，增加不必要的状态负担
**优先级：P2**

**困难度：低**

**当时是否想到：****❌**

**发现问题**：

当前 selected 中存储的是整个 user 对象，而不是更轻量的唯一标识。

**分析问题**：

如果选中态只用于判断“是否已选中”或者展示用户名称，直接存整个对象会引入冗余数据。一旦用户对象结构变大，或者对象引用频繁变化，状态同步和对比成本都会上升。这个问题本质上属于状态建模不够克制。

**解决问题**：

按真实业务需要缩小状态粒度。只关心是否选中时，可以只存 id 列表。只关心展示时，可以额外做映射。

```jsx
const [selectedIds, setSelectedIds] = useState([]);

setSelectedIds(prev => {
  if (prev.includes(user.id)) return prev;
  return [...prev, user.id];
});
```



## 第二章 列表与交互问题
### 3.列表渲染缺少 key，影响 React diff 稳定性
**优先级：P0**

**困难度：低**

**当时是否想到：****❌**

**发现问题**：

users.map 渲染 UserCard 时没有传入 key。

**分析问题**：

React 在进行列表 diff 时需要依赖 key 来识别每一项的身份。如果缺少 key，React 会发出警告，同时可能导致节点复用异常、局部状态错位、更新效率下降。列表场景里，这是必须首先排查的问题之一。

**解决问题**：

给每个列表项传入稳定且唯一的 key，通常使用后端返回的主键字段。

```jsx
{users.map(user => (
  <UserCard key={user.id} user={user} onSelect={handleSelect} />
))}
```

### 4.子元素点击事件冒泡，导致卡片展开逻辑误触发
**优先级：P0**

**困难度：中**

**当时是否想到：****❌**

**发现问题**：

外层卡片绑定了点击切换展开状态，内部按钮点击时没有阻止事件冒泡。

**分析问题**：

用户点击“选择该用户”按钮时，点击事件会从按钮冒泡到父级容器，父容器的展开或收起逻辑也会被触发。于是本来只是一次选择操作，却附带触发了卡片折叠，这属于典型的交互串扰问题。

**解决问题**：

在按钮点击事件中阻止冒泡，把“选择用户”和“切换展开”两个交互隔离开。

```jsx
<button
  onClick={(e) => {
    e.stopPropagation();
    onSelect(user);
  }}
>
  选择该用户
</button>
```

### 13.条件渲染写法不严谨，可能把 0 渲染到页面上
**优先级：P2**

**困难度：低**

**当时是否想到：****✅****，是面试官提醒之后的。**

**发现问题**：

页面中使用了 selected.length && ... 这种写法。

**分析问题**：

在 JSX 里，0 && xxx 的结果是 0，而 React 会把数字 0 正常渲染到页面上。于是当 selected.length 为 0 时，界面上可能直接出现一个不符合预期的 0。这类问题不影响主流程，却很影响页面细节质量。

**解决问题**：

改成更明确的布尔判断或三元表达式。

```jsx
{selected.length > 0 ? selected.map(u => u.name).join(',') : null}
```

### 14.可点击容器使用 div，缺少可访问性支持
**优先级：P2**

**困难度：中**

**发现问题**：

当前用 div 作为可点击卡片容器，但没有补充键盘交互和可访问性语义。

**分析问题**：

鼠标用户可以点击，键盘用户却无法通过 Tab 聚焦和 Enter 触发交互。屏幕阅读器也无法正确理解这个区域的行为角色。这说明当前实现只有“视觉上的可点击”，没有“语义上的可操作”。

**解决问题**：

更合适的方式是使用 button，或者至少补上 role="button"、tabIndex={0} 和键盘事件处理。

```jsx
<div
  role="button"
  tabIndex={0}
  onClick={() => setExpanded(!expanded)}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      setExpanded(prev => !prev);
    }
  }}
>
```

## 第三章 副作用与异步请求问题
### 5.useEffect 依赖不完整，存在潜在副作用风险
**优先级：P1**

**困难度：中**

**当时是否想到：****✅****，是面试官提醒之后的。**

**发现问题**：

useEffect 中使用了 user.id，依赖数组却只写了 expanded。

**分析问题**：

Hook 的依赖数组本质上是副作用的触发条件声明。当前 effect 内部依赖了 user.id，却没有把它写进依赖数组，会导致副作用与真实数据依赖关系不一致。现在这个组件场景下未必立刻报错，但一旦 user 变更或组件复用方式变化，就容易出现旧数据、漏请求或逻辑漂移。

**解决问题**：

把 effect 中真正依赖到的变量完整声明进去。

```jsx
useEffect(() => {
  if (expanded) {
    fetch(`/api/users/${user.id}`)
      .then(res => res.json())
      .then(data => setDetail(data));
  }
}, [expanded, user.id]);
```

### 6.组件重复展开会重复请求，缺少缓存意识
**优先级：P1**

**困难度：低**

**当时是否想到：****✅**

**发现问题**：

每次展开卡片都会重新请求一次用户详情接口，没有对已拉取的数据进行缓存。

**分析问题**：

如果用户频繁展开和收起同一张卡片，就会对同一个用户详情接口发起重复请求。这会增加无意义的网络开销，也会让接口压力变大。对小 demo 来说影响不明显，但放到真实项目里，这是典型的性能浪费。

**解决问题**：

首次加载成功后缓存详情数据。再次展开时优先使用缓存，而不是重新请求。简单做法是在请求前先判断 detail 是否已存在。

```jsx
useEffect(() => {
  if (!expanded || detail) return;
  fetch(`/api/users/${user.id}`)
    .then(res => res.json())
    .then(data => setDetail(data));
}, [expanded, user.id, detail]);
```

更完整的项目里也可以使用 React Query、SWR 这类数据缓存方案。



### 7.异步请求缺少错误处理，失败场景不可控
**优先级：P0**

**困难度：低**

**当时是否想到：****❌**

**发现问题**：

请求链路只有 .then()，没有 .catch()，也没有错误状态。

**分析问题**：

只要接口异常、网络失败、JSON 解析报错，当前组件都不会给用户任何反馈。页面既没有数据，也没有报错提示，用户无法判断到底是正在加载、暂无数据，还是请求已经失败。这会让失败场景完全失控。

**解决问题**：

增加错误捕获逻辑，并维护独立的错误状态，用于展示失败提示。

```jsx
const [error, setError] = useState(null);

useEffect(() => {
  if (!expanded) return;

  fetch(`/api/users/${user.id}`)
    .then(res => res.json())
    .then(data => {
      setDetail(data);
      setError(null);
    })
    .catch(err => {
      setError('加载失败');
    });
}, [expanded, user.id]);
```

### 8.请求过程缺少 loading 状态，用户体验不完整
**优先级：P0**

**困难度：低**

**当时是否想到：****❌**

**发现问题**：

点击展开后，在请求发出到数据返回之间，页面没有任何加载提示。

**分析问题**：

从用户视角看，展开之后内容区域一片空白。用户无法判断当前是接口还没返回，还是这里根本没有数据。没有 loading 状态，本质上是把请求中的中间状态丢失了，交互链路不完整。

**解决问题**：

增加 loading 状态，请求开始时置为 true，请求结束后再恢复。

```jsx
const [loading, setLoading] = useState(false);

useEffect(() => {
  if (!expanded) return;

  setLoading(true);
  fetch(`/api/users/${user.id}`)
    .then(res => res.json())
    .then(data => setDetail(data))
    .finally(() => setLoading(false));
}, [expanded, user.id]);
```

渲染时根据 loading 显示“加载中…”提示即可。

### 9.fetch 响应未校验状态码，异常响应处理不严谨
**优先级：P1**

**困难度：中**

**当时是否想到：****❌**

**发现问题**：

代码拿到响应对象后直接执行 res.json()，没有先判断 res.ok。

**分析问题**：

fetch 和很多人想象的不一样。即使接口返回 404、500，只要网络层请求成功，Promise 依旧会进入成功分支。当前写法会把业务失败也当成成功响应继续往下处理，容易让错误场景变得模糊，后续调试成本上升。

**解决问题**：

先显式校验 res.ok，不通过时主动抛出异常，统一交给错误处理逻辑。

```jsx
fetch(`/api/users/${user.id}`)
  .then(res => {
    if (!res.ok) {
      throw new Error('请求失败');
    }
    return res.json();
  })
  .then(data => setDetail(data))
  .catch(err => setError('加载失败'));
```

### 10.异步请求缺少取消机制，存在竞态与卸载风险
**优先级：P1**

**困难度：中偏高**

**当时是否想到：****❌**

**发现问题**：

当前请求发出后，没有任何清理逻辑。组件收起、切换用户、组件卸载时，请求仍可能在后台继续返回。

**分析问题**：

如果用户快速展开又收起，或者组件已经卸载但请求才返回，就可能出现“旧请求覆盖新状态”或“对已卸载组件更新状态”的问题。这类问题隐蔽性很强，通常在线上更难排查。

**解决问题**：

使用 AbortController 在 effect 清理阶段取消请求，或者用标记位防止过期请求写入状态。

```jsx
useEffect(() => {
  if (!expanded) return;

  const controller = new AbortController();

  fetch(`/api/users/${user.id}`, { signal: controller.signal })
    .then(res => {
      if (!res.ok) throw new Error('请求失败');
      return res.json();
    })
    .then(data => setDetail(data))
    .catch(err => {
      if (err.name !== 'AbortError') {
        setError('加载失败');
      }
    });

  return () => controller.abort();
}, [expanded, user.id]);
```



## 第四章 安全与代码规范问题
### 11.dangerouslySetInnerHTML 直接渲染后端内容，存在 XSS 风险
**优先级：P0**

**困难度：中**

**当时是否想到：****✅****，是面试官提醒之后的。**

**发现问题**：

detail.bio 被直接通过 dangerouslySetInnerHTML 注入到页面中。

**分析问题**：

这个 API 的名字已经说明它有风险。如果后端返回的 HTML 内容中混入恶意脚本、事件处理器或危险标签，前端直接渲染就可能触发跨站脚本攻击。这个问题不属于编码风格问题，而是明确的安全风险。

**解决问题**：

优先避免直接渲染原始 HTML。如果业务确实需要富文本展示，必须先经过可信的清洗流程，再安全渲染。例如由后端统一清洗，或者前端接入 DOMPurify 等库做白名单过滤。

```jsx
import DOMPurify from 'dompurify';

<div
  dangerouslySetInnerHTML={{
    __html: DOMPurify.sanitize(detail.bio)
  }}
/>
```

### 12.使用双等号判断状态，埋下隐式类型转换隐患
**优先级：P2**

**困难度：低**

**当时是否想到：****❌**

**发现问题**：

代码中使用了 user.status == 'active'。

**分析问题**：

双等号会触发隐式类型转换，比较结果不够严格。虽然当前这个例子里大概率不会立刻出错，但从代码规范和长期可维护性角度看，这会增加歧义和误判风险。团队协作里通常都会明确要求使用严格相等。

**解决问题**：

统一改为 ===。

```jsx
{user.status === 'active' ? 'Active' : 'Inactive'}
```



## 第五章 可维护性与性能优化问题
### 16.内联样式散落组件内部，降低样式复用与维护性
**优先级：P3**

**困难度：低**

**当时是否想到：****✅**

**发现问题**：

组件里既定义了 cardStyle，又在 JSX 内部写了多处内联样式。

**分析问题**：

当样式规则比较少时，内联样式问题不大。但随着业务复杂度上升，样式分散在组件逻辑中会导致复用困难、修改成本上升、视觉规则难以统一。后续如果要做主题切换、响应式适配、暗黑模式，维护会更吃力。

**解决问题**：

把样式抽离到 CSS Modules、SCSS、styled-components 或统一的样式方案中。至少要保证结构、状态、主题相关样式有清晰边界。

### 17.组件更新粒度粗，列表场景下存在重渲风险
**优先级：P2**

**困难度：中**

**当时是否想到：****❌**

**发现问题**：

每次 selected 更新时，整个 UserList 都会重新渲染，所有 UserCard 也会跟着重新执行。

**分析问题**：

在用户数量很少时，这个问题不明显。但如果列表很大，频繁更新选中态会带来不必要的重渲染开销。这个问题反映的是组件边界和渲染粒度控制不够精细。

**解决问题**：

可以考虑对 UserCard 使用 React.memo，并保证传入 props 尽量稳定。进一步还可以把选中态判断拆分得更细，减少无关子组件更新。

```jsx
const UserCard = React.memo(function UserCard({ user, onSelect }) {
  // ...
});
```



### 








