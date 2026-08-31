/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

const EXPLICIT_CREATION =
  /(?:创建|新建|新开|开一个)(?:一个)?(?:全新的?|新的?)?(?:普通)?\s*(?:Session|会话|工作|任务)|\b(?:creat(?:e|ing)|start(?:ing)?|open(?:ing)?)\s+(?:a\s+)?(?:brand[- ]new|new)\s+(?:session|work|task)\b/iu;
const NEGATOR =
  /(?:(?:不是|并非)(?:要|想|让你|叫你|请你|说要|打算|准备)|没(?:有)?(?:要|想|让你|叫你|请你|说要|打算|准备)|未(?:打算|准备|想|要)|不希望(?:你)?|不要|别|无需|不用|不需要|先不|暂不|禁止|请勿|切勿|不可|不能|不准|不想|不打算|无意|莫|勿)|\b(?:under\s+no\s+circumstances|do\s+not|don't|never|without|must\s+not|should\s+not|cannot|can't|may\s+not|will\s+not|won't|would\s+not|wouldn't|no\s+need\s+to|refrain\s+from|refuse\s+to|decline\s+to|avoid|not(?!\s+only\b))\b/iu;
const ANAPHORIC_CANCELLATION =
  /(?:不要|别|无需|不用|不需要|先不|暂不|请勿|切勿|不可|不能|不准)(?:再)?(?:这样|这么|照此)(?:做|操作|执行)?|(?:算了|取消)(?:吧|这个|这项操作)?|\b(?:(?:do\s+not|don't|never|must\s+not|should\s+not|cannot|can't)\s+(?:do\s+)?(?:that|it)|(?:cancel|scratch)\s+(?:that|it)|never\s+mind)\b/iu;
const BARE_TRAILING_CANCELLATION =
  /(^|\r\n|[\r\n,.!?;，。！？；—–-]|\b(?:but|and(?:\s+then)?)\b|不过|但是|但|然后|随后)([^\S\r\n]*)((?:还是)?(?:别|不要)了|(?:actually\s*,?\s*)?(?:do\s+not|don't))\s*[.!?。！？]?\s*$/iu;
const ABBREVIATION_BEFORE_BOUNDARY = /(?:\b[a-z0-9]\.[a-z0-9]|\b(?:etc|vs|mr|mrs|dr))\.\s*,?$/iu;
const MULTILINE_LITERAL_INTRODUCER = /[:：]\s*$/u;
const EXACT_LITERAL_HEADER =
  /^(?:(?:this|the|these|following|list)\s+)?(?:token|tokens|value|values|label|labels|literal|literals|input|inputs|code|example|examples|case|cases|item|items|text|string|strings)$|^(?:此|这个|这些|以下)?(?:文案|值|文本|字符串|输入|代码|示例|字面量|令牌)$/iu;
const ACTION_INTRODUCER_PREFIX =
  /^(?:please|(?:can|could|would)\s+you|请|帮我|请帮我|麻烦(?:你)?)?$/iu;
const STRUCTURED_LITERAL_LINE =
  /^\s*(?:(?:[-*+]|\d+[.)])\s*)?(?:(?:do\s+not|don't)|(?:还是)?(?:别|不要)了)\s*[.!?。！？]?\s*$/iu;
const PRIOR_STRUCTURED_LITERAL_ITEM = /^(?:\t| {4}|\s*(?:[-*+]|\d+[.)])\s+\S)/u;
const EXECUTION_ACTION =
  /(?:修复|修改|更新|实现|创建|新增|删除|移除|处理|完成|运行|测试|提交|推送|检查|诊断|复现|优化|补充|整理)|\b(?:fix|modify|implement|update|create|add|remove|delete|handle|finish|run|test|commit|push|check|optimize|try|reproduce|diagnose|work)\b/iu;
const CREATION_ACTION = /(?:创建|新建|新开|开一个)|\b(?:create|start|open)\b/iu;
const ANAPHORIC_OBJECT = /^\s*(?:(?:it|one|that|this)\b|(?:它|这个|这项工作|这项任务))/iu;
const DELIBERATIVE_REQUEST =
  /^\s*(?:(?:(?:我们|我)\s*)?(?:是否|要不要|该不该|应不应该|能不能|可不可以|为什么|如何|怎么|想知道(?:是否|为什么|如何|怎么)|应该(?:如何|怎么))|(?:should|whether|why|how|(?:can|could|would)\s+(?:we|i)|what\s+(?:is|are|was|were|should|would|could|do|does|did|can))\b|(?:i|we)\s+(?:(?:want|would\s+like)\s+to\s+(?:know|understand)|wonder)\s+(?:whether|why|how)\b|(?:(?:(?:can|could|would)\s+you\s+)?(?:(?:please|kindly)\s+)?(?:explain|discuss|consider|tell\s+me|help\s+me\s+understand)\s+(?:whether|why|how|when|if|in\s+which\s+cases?)\b)|(?:(?:请|帮我|请帮我|麻烦(?:你)?)\s*)?(?:解释|讨论|考虑|告诉我|帮我理解).{0,18}(?:是否|为什么|如何|怎么|何时|什么时候|在什么情况))/iu;
const ADVISORY_SPEECH_ACT =
  /^\s*(?:(?:can|could|would)\s+you(?:\s+(?:please|kindly))?|please|kindly)?\s*(?:recommend|suggest|advise|explain|discuss|consider|tell\s+me|help\s+me\s+understand|show\s+me|teach\s+me|walk\s+me\s+through)\b|^\s*(?:(?:请|帮我|请帮我|麻烦(?:你)?)\s*)?(?:建议|解释|讨论|考虑|告诉我|帮我理解|教我|讲讲)/iu;
const COORDINATED_DIRECT_ACTION_PREFIX =
  /(?:(?:[,.;]\s*)(?:(?:and|but)\s*)?|(?:and\s+then|then)\s*|(?:[，。；]\s*)(?:(?:并且|并|但|不过)\s*)?|然后\s*)$/iu;
const ADVISORY_MATRIX_ACTION_BOUNDARY =
  /(?:,\s*(?:and|but|then)|[.;]\s*(?:(?:and|but|then)\s*)?|，\s*(?:然后|并且|并|但|不过)|[。；]\s*(?:(?:然后|并且|并|但|不过)\s*)?)\s*$/iu;
const BARE_COORDINATED_ACTION_PREFIX = /(?:\band\s*|并且\s*|并\s*)$/iu;
const ADVISORY_COMPLEMENT_NOUN =
  /\b(?:ways?|methods?|techniques?|approaches?|circumstances?|cases?|steps?|options?|strategies?|solutions?|patterns?|process(?:es)?|procedures?|frameworks?|workflows?|proposals?|tools?)\b|(?:方法|方式|技巧|方案|步骤|流程|框架|工作流|提案|工具|选项|策略|模式|情形|情况)/iu;
const ADVISORY_COMPLEMENT_RELATIVE = /\b(?:to|that|which|where)\b[^,.;!?]{0,80}\band\s*$/iu;
const TRAILING_QUESTION = /[?？]\s*$/u;
const DELIBERATIVE_LEAD_MARKER =
  /\b(?:how|why|whether|when)\b|\bin\s+which\s+cases?\b|\bif\s+(?:(?:i|we|you|they|it)\s+(?:should|could|would|can|need|must|ought)\b|it\s+is\s+necessary\b)|\b(?:what|which)\s+(?:steps?|approach|method|way|cases?)\b|\b(?:show|teach)\s+me\b|\bwalk\s+me\s+through\b|(?:想知道|想了解|是否|应否|要不要|该不该|应不应该|能不能|可不可以|为什么|如何|怎么|何时|什么时候|在什么情况|教我|讲讲)/iu;
const DIRECT_EXECUTION_PREFIX =
  /^\s*(?:(?:(?:if|when)\b[^,\r\n]{1,80}?(?:,\s*|\bthen\s+|\s+(?=(?:can|could|would)\s+you\b))|如果[^，\r\n]{1,48}?(?:，\s*|然后\s*|\s+(?=请|帮我|请帮我|麻烦))))?(?:(?:can|could|would)\s+you(?:\s+(?:please|kindly))?|(?:i\s+(?:want|need|would\s+like)|we\s+need)\s+(?:you\s+)?to|let['’]s|let\s+us|please|kindly|请|帮我|请帮我|麻烦(?:你)?|我想(?:让你)?|我要(?:让你)?|我们需要(?:你)?)?\s*$/iu;
const CONDITIONAL_EXECUTION_PREFIX =
  /^\s*(?:(?:if|when)\b[^?？\r\n]{1,80}|如果[^?？\r\n]{1,48})\s*$/iu;
const ELLIPTICAL_CONDITIONAL_PREFIX =
  /^\s*(?:if|when)\s+(?:needed|required|necessary|possible|safe|appropriate|convenient|ready|available|feasible|desired|applicable|practical|advisable|permitted|complete|urgent|sensible)\s*$/iu;
const DELIBERATIVE_CONDITIONAL_PREFIX =
  /^(?:(?:if|when)\s+(?:(?:the\s+)?[\p{L}][\p{L}'’-]*|[^,，?？]{1,64}\b(?:should|could|would|can|need|must|ought|will|may|might|do|does|did|is|are|was|were|has|have|had))|如果(?:(?:我|我们|你|你们|他们|她们|它们)|[^，,？?]{1,32}(?:能|会|将|要|可以|应该)))\s*$|\bif\s+(?:i|we|you|they|it)\s+(?:should|could|would|can|need|must|ought)\b|\bwhen\s+(?:should|could|would|can|may|might|must|ought|will|do|does|did|is|are|was|were)\b|\bif\b[^,，?？]{0,64}\b(?:think|believe|suppose|wonder|feel|guess|asked?|wanted?|preferred?)\b|\bif\b[^,，?？]{0,64}\bplan\s+(?:is|was|were|would\s+be)\s+to\b|\b(?:if|when)\b[^,，]{0,64}\b(?:whether|how|why|unsure|uncertain|unclear|appropriate|advisable|wise|good\s+idea|makes?\s+sense|in\s+doubt|ask)\b|如果[^，,]{0,32}(?:是否|应否|应不应该|该不该|要不要|什么时候|不确定|不清楚|疑问|适合|合适|可行|明智|合理|(?:我|我们)?(?:让|叫|要求)你)/iu;
const POST_ACTION_DELIBERATIVE =
  /\b(?:or|but|however|actually|instead)\b[^?？\r\n]{0,80}\b(?:should|could|would|maybe|perhaps|not\s+sure|changed?\s+(?:my|our)\s+mind|take\s+(?:it|that)\s+back)\b|(?:^|[.;!?])\s*(?:(?:on\s+second\s+thought)\s*,?\s*)?(?:(?:maybe|perhaps)\b|(?:(?:do\s+you\s+(?:think|agree)|(?:is|are|was|were|do|does|did|can|could|should|would)\s+(?:i|we|it|that|this)|(?:are|were)\s+(?:you|they)\s+sure)\b|(?:i|we)(?:\s+(?:am|are)|['’](?:m|re))?\s+not\s+sure))|(?:还是|或者|但是|但|不过|其实|不然|[。；！？])[^?？\r\n]{0,48}(?:应该|要不要|是否|也许|可能|不确定|改主意|等等|先等|搁置|明智|合适|合理|可行|可以吗|好吗|妥当)|(?:合适|合理|可行|明智|妥当|可以吗|好吗)\s*吗?？?\s*$/iu;
const POST_ACTION_QUESTION_ALTERNATIVE = /\bor\b|还是|或者/iu;
const POST_ACTION_QUESTION_CLAUSE_LEAD =
  /^(?:what|how|why|whether|when|who|where)\b|^(?:would|could|should|can|do|does|did|is|are|was|were|will|may|might|must)\s+(?:i|we|you|they|it|that|this|the)\b|^(?:什么|如何|为什么|是否|何时|什么时候|谁|哪里|哪种|可以|应该|要不要|是不是)/iu;
const POST_ACTION_EMBEDDED_QUESTION =
  /\b(?:what|how|why|whether|when|who|where)\s+(?:would|could|should|will|can|do|does|did|is|are)\b|\b(?:would|could|should|can|will|may|might|must)\s+(?:that|this|it|the)\b|(?:会怎样|会如何|怎么办|是否合适|是否可行)/iu;
const POST_ACTION_UNCERTAINTY_TAG =
  /^(?:maybe|perhaps|okay|ok|right|agreed|not\s+sure|any\s+(?:concerns?|objections?)|sound\s+good)\b|^(?:可以吗|好吗|行吗|对吗|没问题吧|有问题吗|有疑问吗)/iu;
const UNQUOTED_LITERAL_QUESTION_TARGET =
  /\b(?:to|as|say(?:ing)?|answer(?:ing)?(?:\s+the\s+question)?)\s+(?:what|how|why|when|where|who)\b/iu;
const POSITIVE_CONTRAST = /而是|\b(?:but|instead)\b/iu;
const HARD_CLAUSE_BOUNDARY = /[.!?;。！？；]/u;
const SOFT_CLAUSE_BOUNDARY = /[,，]/u;
const ACTION_TARGET_SCAFFOLDING =
  /^(?:(?:\s+\b(?:and|then|also|please|kindly|really|actually|absolutely|just|simply|can|could|would|you)\b)|(?:并且|并|且|然后|随后|请|麻烦|你|真的|确实|务必|千万))+\s*$/iu;
const CORRECTION_CUE =
  /^\s*(?:(?:不是|不要再继续)\s*(?:这个|那个|当前这个|刚才那个)(?:工作|任务|Session|会话)?|(?:这个|那个|当前这个|刚才那个)(?:工作|任务|Session|会话)?\s*(?:不对|搞错了|弄错了)|(?:不对|错了|搞错了|弄错了)|(?:no|nope)\b(?=\s*[,.;:!?—–-])|not\s+(?:this|that|the\s+current)(?:\s+(?:one|session|work|task))?|wrong\s+(?:one|session|work|task))/iu;
const CORRECTION_RETARGET_ACTION =
  /(?:应该(?:是|用|改成|改为|切到|转到)|而是|改成|改为|换成|换到|切到|转到|用)|\b(?:use|switch(?:\s+(?:it|this|that))?\s+to|change(?:\s+(?:it|this|that))?\s+to|move(?:\s+(?:it|this|that))?\s+to|send(?:\s+(?:it|this|that))?\s+to)\b/iu;
const CORRECTION_CLAUSE_BOUNDARY = /[\r\n,.;!?，。；！？—–]/u;
const CORRECTION_TRAILING_WITHDRAWAL =
  /(?:(?:\b(?:but|however|actually|and(?:\s+then)?)\b|[,.;!?—–])[^\r\n]{0,80}\b(?:(?:do\s+not|don't)\s+(?:(?:want|intend|plan)\s+to\s+)?(?:move|switch|change|send|use|do)|never(?:\s+(?:move|switch|change|send|use|do|again|mind))?|no\s+longer\s+(?:move|switch|change|send|use|do))\b|(?:但|不过|其实|然后|随后|[，。；！？])[^\r\n]{0,48}(?:不想|不要|别|不再|不用)[^\r\n]{0,12}(?:转|换|切|用|做|了))/iu;
const TERMINAL_WITHDRAWAL_CLAUSE =
  /(?:^|[\r\n,.;!?—–-]|\b(?:and|then|but|or|however|actually|instead)\b)\s*(?:abort|cancel|stop|halt|cease|quit|pause|terminate|withdraw|revoke|abandon|retract|forget)(?:\s+(?:(?:it|this|that|my|our|your|the)(?:\s+(?:operation|work|request|job|task|session|creation|change|action))?|everything|all|(?:the\s+)?new\s+session))?(?:\s+(?:immediately|now|here|for\s+now))?[.!?]?\s*$|(?:^|[\r\n,.;!?—–-]|\b(?:and|then|but|or|however|actually|instead)\b)\s*(?:(?:on\s+second\s+thought)\s*,?\s*)?(?:(?:maybe|perhaps)\s+)?(?:(?:(?:should|could|would)\s+(?:we|i)|(?:we|i)\s+(?:should|could|would))\s+)?(?:wait|hold\s+off|leave\s+(?:it|this|that)(?:\s+(?:here|alone|for\s+now))?|keep\s+(?:it|this|that)\s+here|scratch\s+(?:it|this|that)|stand\s+down|back\s+out|call\s+it\s+off|do\s+nothing|take\s+(?:it|that)\s+back)[.!?]?\s*$|(?:^|[\r\n,.;!?—–-]|\b(?:and|then|but|or|however|actually|instead)\b)\s*(?:(?:on\s+second\s+thought)\s*,?\s*)?(?:(?:i|we)(?:\s+(?:have|had))?\s+changed?\s+(?:my|our)\s+mind|(?:i|we)(?:\s+(?:am|are)|['’](?:m|re))?\s+not\s+sure|(?:i\s+)?take\s+(?:it|that)\s+back)[.!?]?\s*$/iu;
// Extends the compact terminal-state grammar above with polite speech acts,
// qualified objects, and unambiguous command synonyms.
const TERMINAL_QUALIFIED_WITHDRAWAL_COMMAND =
  /(?:^|[\r\n,.;!?，。！？；—–-]|\b(?:and|then|but|or|however|actually|instead)\b|然后|随后|但是|但|不过|其实|还是|或者)\s*(?:(?:(?:please|kindly|let['’]s|let\s+us|(?:can|could|would)\s+you|(?:i|we)\s+(?:(?:would\s+)?prefer|want|need|would\s+like)\s+to)\s+)(?:abort|cancel|stop|halt|cease|quit|pause|terminate|withdraw|revoke|abandon|retract|forget|rescind|drop|scrap|undo|discontinue|ditch|discard)(?:\s+(?:(?:it|this|that)(?:\s+(?:operation|work|request|job|task|session|creation|change|action))?|(?:(?:my|our|your|the)\s+)?(?:(?:current|pending|active|existing|new)\s+)?(?:operation|work|request|job|task|session|creation|change|action)|everything|all))?|(?:abort|cancel|stop|halt|cease|quit|pause|terminate|withdraw|revoke|abandon|retract|forget)\s+(?:(?:my|our|your|the)\s+)?(?:current|pending|active|existing)\s+(?:operation|work|request|job|task|session|creation|change|action)|(?:rescind|drop|scrap|undo|discontinue|ditch|discard)(?:\s+(?:(?:it|this|that)(?:\s+(?:operation|work|request|job|task|session|creation|change|action))?|(?:(?:my|our|your|the)\s+)?(?:(?:current|pending|active|existing|new)\s+)?(?:operation|work|request|job|task|session|creation|change|action)|everything|all))?)(?:\s+(?:immediately|now|here|for\s+now))?[.!?]?\s*$/iu;
const TERMINAL_NEGATED_CONTINUATION =
  /(?:^|[\r\n,.;!?，。！？；:：—–-]|\b(?:and|then|but|or|however|actually|instead)\b|然后|随后|但是|但|不过|其实|还是|或者)\s*(?:please\s+)?(?:(?:(?:i|we)\s+)?(?:do\s+not|don't|never)\s+(?:(?:wish|want|prefer|intend|plan)\s+to\s+)?(?:proceed|continue|go\s+ahead)(?:\s+(?:with\s+)?(?:(?:it|this|that)|(?:(?:my|our|your|the)\s+)?(?:current\s+)?(?:operation|work|request|job|task|session|creation|change|action)))?|never\s+mind)[.!?]?\s*$/iu;
const TERMINAL_CHINESE_WITHDRAWAL =
  /(?:^|[\r\n，。；！？—–-]|然后|随后|但是|但|不过|其实|还是|或者)\s*(?:(?:不要|别|不想|不再|不用)(?:再)?(?:继续|执行|推进|转|换|切|用|做)|(?:作罢|取消|停止|停下|中止|终止|放弃|暂停|算了|撤回)(?:吧|它|这个|这项(?:操作|工作|请求)|全部|现在|执行|创建(?:新(?:的)?(?:会话|工作|任务))?)?|(?:(?:也许|可能)?(?:还是)?(?:应该|可以)?\s*)?(?:等等|先等|搁置|推迟|我(?:改主意了?|不确定|再想想))|当我没说|维持原样|保持原样|还是算了)[。！？]?\s*$/iu;
const CREATION_REQUEST_PREFIX =
  /^(?:(?:please|kindly|(?:can|could|would)\s+you|i\s+(?:want|need|would\s+like)\s+to|we\s+need\s+to|let['’]s)|(?:请|帮我|请帮我|麻烦(?:你)?|我想|我要|我们需要))?\s*$/iu;
const NAMED_CREATION_TITLE_INTRODUCER =
  /\b(?:new|brand[- ]new)\s+(?:session|work|task)[\s,，:：-]+(?:(?:called|named|titled)|with\s+(?:the\s+)?title)\s+|(?:新的?|全新的?)?\s*(?:Session|会话|工作|任务)[\s,，:：-]*(?:叫做?|名叫|名为|命名为|标题为|名称为|名字为)\s*/iu;
const LEADING_CORRECTION_SEPARATOR = /^[\s,.;:!?，。；：！？—–-]+/u;

/** How much authority trusted user text carries for starting work. */
export type WorkHubExecutionIntent = 'imperative' | 'ambiguous' | 'non_executable';

/** Naming syntax is total: absent, parsed, or present but unsafe to use. */
export type WorkHubCreationNaming =
  | { readonly kind: 'none' }
  | { readonly kind: 'unusable' }
  | { readonly kind: 'named'; readonly title: string };

export interface WorkHubRequestIntent {
  readonly execution: WorkHubExecutionIntent;
  readonly creation: {
    readonly explicit: boolean;
    readonly naming: WorkHubCreationNaming;
  };
  readonly correction: {
    readonly cue: boolean;
    readonly existingTarget?: string;
  };
}

/**
 * Whether trusted user text affirmatively asks WorkHub to create a new Session.
 *
 * Routing is advisory, so both renderer policy and the Runtime Action Gate use
 * this conservative predicate. Weak punctuation never separates a negator from
 * its creation verb; only an explicit contrast can introduce a later positive
 * creation clause.
 */
function isExplicitWorkHubCreationRequest(value: string): boolean {
  const normalized = value.replace(/[’‘]/gu, "'");
  const creations = allMatches(normalized, EXPLICIT_CREATION);
  if (
    creations.length === 0 ||
    isDeliberative(normalized) ||
    hasUnquotedTerminalWithdrawal(normalized) ||
    hasUnsafeUnquotedNamedCreationTail(normalized) ||
    !creations.some((creation) => hasAffirmativeCreationGrammar(normalized, creation))
  ) {
    return false;
  }
  return !hasNegatedWorkHubCreationRequest(normalized);
}

/** The explicit title when an affirmative creation request names its new Session. */
function affirmativeWorkHubNamedCreationTitle(value: string): string | undefined {
  if (!isExplicitWorkHubCreationRequest(value)) return undefined;
  const normalized = value.replace(/[’‘]/gu, "'");
  const lastIntroducer = affirmativeNamedCreationIntroducer(normalized);
  if (lastIntroducer?.index === undefined) return undefined;
  return parseNamedCreationTitle(normalized.slice(lastIntroducer.index + lastIntroducer[0].length));
}

/** Whether the request contains syntax that explicitly names its new Session. */
function hasWorkHubNamedCreationClause(value: string): boolean {
  return NAMED_CREATION_TITLE_INTRODUCER.test(value.replace(/[’‘]/gu, "'"));
}

function affirmativeNamedCreationIntroducer(value: string): RegExpMatchArray | undefined {
  const affirmativeCreation = allMatches(value, EXPLICIT_CREATION)
    .filter(
      (creation) =>
        creation.index !== undefined &&
        hasAffirmativeCreationGrammar(value, creation) &&
        !isMatchNegated(value, creation),
    )
    .at(-1);
  if (affirmativeCreation?.index === undefined) return undefined;
  const creationStart = affirmativeCreation.index;
  const creationEnd = creationStart + affirmativeCreation[0].length;
  return allMatches(value, NAMED_CREATION_TITLE_INTRODUCER).find(
    (introducer) =>
      introducer.index !== undefined &&
      introducer.index >= creationStart &&
      introducer.index < creationEnd,
  );
}

function hasAffirmativeCreationGrammar(value: string, creation: RegExpMatchArray): boolean {
  if (creation.index === undefined) return false;
  const correctionCue = CORRECTION_CUE.exec(value);
  if (correctionCue?.index !== undefined) {
    const correctionClause = value
      .slice(correctionCue.index + correctionCue[0].length)
      .replace(LEADING_CORRECTION_SEPARATOR, '');
    if (isDeliberative(correctionClause)) return false;
    const prefix = afterLastDecisionReset(value.slice(0, creation.index))
      .replace(CORRECTION_CUE, '')
      .replace(LEADING_CORRECTION_SEPARATOR, '')
      .trim();
    return CREATION_REQUEST_PREFIX.test(prefix);
  }
  return CREATION_REQUEST_PREFIX.test(
    afterLastDecisionReset(value.slice(0, creation.index)).trim(),
  );
}

/** Whether trusted user text negates creation rather than authorizing it. */
function hasNegatedWorkHubCreationRequest(value: string): boolean {
  const normalized = value.replace(/[’‘]/gu, "'");
  const lastCreation = lastMatch(normalized, EXPLICIT_CREATION);
  const trailing =
    lastCreation?.index === undefined
      ? ''
      : normalized.slice(lastCreation.index + lastCreation[0].length);
  if (
    lastCreation?.index !== undefined &&
    (ANAPHORIC_CANCELLATION.test(trailing) ||
      hasBareTrailingCancellation(normalized) ||
      hasNegatedAnaphoricCreation(normalized, lastCreation))
  ) {
    return true;
  }
  let lastDecision: boolean | undefined;
  for (const segment of normalized.split(POSITIVE_CONTRAST)) {
    const creation = lastMatch(segment, EXPLICIT_CREATION);
    if (!creation || creation.index === undefined) continue;
    lastDecision = NEGATOR.test(segment.slice(0, creation.index));
  }
  return lastDecision ?? false;
}

/** Whether already-normalized, literal-masked text is an executable instruction. */
function isImperativeWorkHubNewTopicRequest(normalized: string): boolean {
  const actions = allMatches(normalized, EXECUTION_ACTION);
  if (isDeliberative(normalized) || hasUnquotedTerminalWithdrawal(normalized)) {
    return false;
  }
  if (
    hasWorkHubNamedCreationClause(normalized) &&
    !affirmativeWorkHubNamedCreationTitle(normalized)
  ) {
    return false;
  }
  const explicitCreation = isExplicitWorkHubCreationRequest(normalized);
  if (
    EXPLICIT_CREATION.test(normalized) &&
    !isExplicitWorkHubCreationRequest(normalized) &&
    actions.length > 0 &&
    actions.every((action) => CREATION_ACTION.test(action[0]))
  ) {
    return false;
  }
  if (hasNegatedWorkHubCreationRequest(normalized)) {
    const lastCreation = lastMatch(normalized, EXPLICIT_CREATION);
    if (!lastCreation || lastCreation.index === undefined) return false;
    if (isMatchNegated(normalized, lastCreation)) return false;
    const trailing = normalized.slice(lastCreation.index + lastCreation[0].length);
    return [...executionActionDecisions(trailing).values()].some(Boolean);
  }
  return (
    (explicitCreation || hasAffirmativeExecutableGrammar(normalized, actions)) &&
    [...executionActionDecisions(normalized).values()].some(Boolean)
  );
}

/**
 * Read trusted user text once at the WorkHub intent boundary.
 *
 * Heuristics may demote toward doing nothing; they must never promote an
 * advisory or malformed phrase into authority to create work.
 */
export function readWorkHubRequestIntent(value: string): WorkHubRequestIntent {
  const literalMask = maskLiteralSpans(value);
  const source = value.replace(/[’‘]/gu, "'");
  const masked = literalMask.value.replace(/[’‘]/gu, "'");
  const explicit = isExplicitWorkHubCreationRequest(masked);
  const hasNamingClause = hasWorkHubNamedCreationClause(source);
  const namedTitle = explicit ? affirmativeWorkHubNamedCreationTitle(source) : undefined;
  const naming: WorkHubCreationNaming = !hasNamingClause
    ? { kind: 'none' }
    : namedTitle
      ? { kind: 'named', title: namedTitle }
      : { kind: 'unusable' };
  const correctionCue = hasWorkHubCorrectionCue(source);
  const existingTarget = affirmativeWorkHubExistingCorrectionTarget(source);
  const actions = allMatches(masked, EXECUTION_ACTION);
  const execution: WorkHubExecutionIntent =
    literalMask.malformed || naming.kind === 'unusable' || hasDominatingDeliberation(masked)
      ? 'non_executable'
      : hasAmbiguousAdvisoryCommand(masked, actions)
        ? 'ambiguous'
        : isImperativeWorkHubNewTopicRequest(masked)
          ? 'imperative'
          : 'non_executable';
  return {
    execution,
    creation: { explicit, naming },
    correction: {
      cue: correctionCue,
      ...(existingTarget ? { existingTarget } : {}),
    },
  };
}

/** Whether a parsed correction names exactly this Session. */
export function workHubCorrectionTargetsSession(
  intent: WorkHubRequestIntent,
  sessionName: string,
): boolean {
  return Boolean(
    intent.correction.existingTarget &&
      correctionTargetMatchesSession(intent.correction.existingTarget, sessionName),
  );
}

/** Whether parsed trusted text authorizes the title proposed for new work. */
export function workHubCreationAuthorizesTitle(
  intent: WorkHubRequestIntent,
  title: string,
): boolean {
  if (intent.execution !== 'imperative') return false;
  if (intent.creation.naming.kind === 'unusable') return false;
  if (intent.creation.naming.kind === 'none') return true;
  return (
    normalizeCorrectionIdentity(intent.creation.naming.title) === normalizeCorrectionIdentity(title)
  );
}

/** Whether trusted user text affirmatively redirects an existing WorkHub delegation. */
function isAffirmativeWorkHubExistingTargetCorrectionRequest(
  value: string,
  expectedTargetName?: string,
): boolean {
  const target = affirmativeWorkHubExistingCorrectionTarget(value);
  return Boolean(
    target && (!expectedTargetName || correctionTargetMatchesSession(target, expectedTargetName)),
  );
}

/** The bounded target phrase from an affirmative existing-Session correction. */
function affirmativeWorkHubExistingCorrectionTarget(value: string): string | undefined {
  const normalized = value.replace(/[’‘]/gu, "'");
  if (!hasWorkHubCorrectionCue(normalized) || isDeliberative(normalized)) return undefined;
  const actions = allMatches(normalized, CORRECTION_RETARGET_ACTION);
  let lastDecision = false;
  let lastAction: RegExpMatchArray | undefined;
  let lastTarget = '';
  for (const action of actions) {
    if (action.index === undefined) continue;
    const prefix = normalized.slice(0, action.index);
    const clausePrefix = prefix.slice(lastBoundaryEnd(prefix, CORRECTION_CLAUSE_BOUNDARY));
    const target = normalized.slice(action.index + action[0].length).trim();
    if (!target) continue;
    lastDecision = !NEGATOR.test(clausePrefix);
    lastAction = action;
    lastTarget = target;
  }
  if (!lastDecision || lastAction?.index === undefined) return undefined;
  const trailing = normalized.slice(lastAction.index + lastAction[0].length);
  if (
    ANAPHORIC_CANCELLATION.test(trailing) ||
    CORRECTION_TRAILING_WITHDRAWAL.test(trailing) ||
    hasBareTrailingCancellation(normalized)
  ) {
    return undefined;
  }
  return lastTarget;
}

function correctionTargetMatchesSession(target: string, sessionName: string): boolean {
  const normalizedTarget = normalizeCorrectionIdentity(target);
  const normalizedName = normalizeCorrectionIdentity(sessionName);
  if (!normalizedName) return false;
  const quotedNames = [
    `"${normalizedName}"`,
    `“${normalizedName}”`,
    `'${normalizedName}'`,
    `‘${normalizedName}’`,
  ];
  const matchedName = [normalizedName, ...quotedNames]
    .sort((left, right) => right.length - left.length)
    .find(
      (candidate) =>
        normalizedTarget.startsWith(candidate) &&
        !/[\p{L}\p{N}]/u.test(normalizedTarget[candidate.length] ?? ''),
    );
  if (!matchedName) return false;
  if (matchedName === normalizedName && hasUnsafeUnquotedHardClauseBoundary(sessionName)) {
    return false;
  }
  if (hasUnquotedTerminalWithdrawal(target)) {
    return false;
  }
  const remainder = normalizedTarget.slice(matchedName.length).trim();
  if (!remainder || /^(?:instead\s*)?[.!?。！？]?$/iu.test(remainder)) return true;
  const supplemental = remainder.match(/^[,;，；]\s*(.+)$/u)?.[1]?.trim();
  const supplementalBody = supplemental?.replace(/[.!?。！？]+\s*$/u, '').trim();
  return Boolean(
    supplementalBody &&
      !/[\r\n,.!?;，。！？；—–]|\b(?:and|then|but|however|actually)\b|(?:然后|随后|但|不过|其实)/iu.test(
        supplementalBody,
      ) &&
      readWorkHubRequestIntent(supplementalBody).execution === 'imperative',
  );
}

function normalizeCorrectionIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function hasUnquotedTerminalWithdrawal(value: string): boolean {
  const masked = maskLiteralSpans(value).value;
  const withdrawal =
    TERMINAL_WITHDRAWAL_CLAUSE.exec(masked) ??
    TERMINAL_QUALIFIED_WITHDRAWAL_COMMAND.exec(masked) ??
    TERMINAL_NEGATED_CONTINUATION.exec(masked) ??
    TERMINAL_CHINESE_WITHDRAWAL.exec(masked);
  return withdrawal?.index !== undefined;
}

function hasUnsafeUnquotedNamedCreationTail(value: string): boolean {
  const introducer = affirmativeNamedCreationIntroducer(value);
  if (introducer?.index === undefined) return false;
  const trailing = value.slice(introducer.index + introducer[0].length).trim();
  if (!trailing || new Set(['"', "'", '“', '‘']).has(trailing[0] ?? '')) return false;
  const boundary = unquotedCreationTitleBoundary(trailing);
  if (boundary >= trailing.length) return false;
  const separator = trailing[boundary] ?? '';
  const suffix = trailing.slice(boundary + 1).trim();
  if (!suffix) return false;
  const actionableSuffix = stripExecutionScaffolding(suffix);
  if (isDeliberative(actionableSuffix) || hasUnquotedTerminalWithdrawal(actionableSuffix)) {
    return true;
  }
  if (/[.!?;。！？；]/u.test(separator)) {
    return !isScaffoldedDirectExecutableClause(actionableSuffix);
  }
  return !/^(?:(?:and|then|but)\b|然后|随后|但是|但|只)/iu.test(suffix);
}

function isDirectExecutableClause(value: string): boolean {
  const action = EXECUTION_ACTION.exec(value);
  if (action?.index === undefined || !isDirectExecutionPrefix(value.slice(0, action.index))) {
    return false;
  }
  return [...executionActionDecisions(value).values()].some(Boolean);
}

function isScaffoldedDirectExecutableClause(value: string): boolean {
  return isDirectExecutableClause(stripExecutionScaffolding(value));
}

function stripExecutionScaffolding(value: string): string {
  let current = value.trim();
  while (current) {
    const next = current
      .replace(
        /^(?:(?:and\s+then|then|next|first|also|now|finally|afterwards?|thereafter|subsequently|eventually|immediately|urgently|promptly|directly|and|but)\b[\s,]*|(?:please|kindly|proceed\s+to|go\s+ahead\s+(?:and|to)|continue\s+to|at\s+that\s+point)\b[\s,]*|(?:然后|随后|接着|接下来|下一步|最后|并且|并|但是|但)[\s，,]*)/iu,
        '',
      )
      .trimStart();
    if (next === current) break;
    current = next;
  }
  return current;
}

function parseNamedCreationTitle(value: string): string | undefined {
  const trailing = value.trim();
  const quotePair = new Map([
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ]).get(trailing[0] ?? '');
  if (quotePair) {
    const closing = trailing.indexOf(quotePair, 1);
    return closing > 1 ? trailing.slice(1, closing).trim() || undefined : undefined;
  }
  const boundary = unquotedCreationTitleBoundary(trailing);
  return (
    trailing
      .slice(0, boundary)
      .trim()
      .replace(/[.!?。！？]+\s*$/u, '')
      .replace(/\s+instead\s*$/iu, '')
      .trim() || undefined
  );
}

function unquotedCreationTitleBoundary(value: string): number {
  let boundary = /[\r\n,!?;，。！？；—–]/u.exec(value)?.index ?? value.length;
  for (
    let index = value.indexOf('.');
    index >= 0 && index < boundary;
    index = value.indexOf('.', index + 1)
  ) {
    const prefix = value.slice(0, index);
    const after = value.slice(index + 1);
    if (isTitleAbbreviation(prefix, after)) continue;
    if (!after || /^\s/u.test(after) || /^\p{Lu}/u.test(after)) boundary = index;
  }
  return boundary;
}

function hasUnsafeUnquotedHardClauseBoundary(value: string): boolean {
  const trimmed = value.trim();
  const hardBoundary = /[!?;。！？；]/u.exec(trimmed);
  if (hardBoundary?.index !== undefined && trimmed.slice(hardBoundary.index + 1).trim())
    return true;
  for (let index = trimmed.indexOf('.'); index >= 0; index = trimmed.indexOf('.', index + 1)) {
    const after = trimmed.slice(index + 1);
    if (!after.trim() || isTitleAbbreviation(trimmed.slice(0, index), after)) continue;
    if (/^\s|^\p{Lu}/u.test(after)) return true;
  }
  return false;
}

function isTitleAbbreviation(prefix: string, after: string): boolean {
  const token = prefix.match(/[A-Za-z.]+$/u)?.[0] ?? '';
  if (isScaffoldedDirectExecutableClause(after.trimStart())) return false;
  if (/\d$/u.test(prefix) && /^\d/u.test(after)) return true;
  if (/^[A-Z]$/u.test(token) && /^[A-Z]\./u.test(after)) return true;
  if (/^[A-Z][a-z]{0,2}$/u.test(token) && /^[A-Z]\./u.test(after)) return true;
  if (/^(?:[A-Za-z]\.)+[A-Za-z]$/u.test(token)) return true;
  if (/^[A-Z][a-z]{0,2}(?:\.[A-Z])+$/u.test(token)) return true;
  return /^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|inc|no|ltd|co|corp)$/iu.test(token);
}

/** Whether trusted user text affirmatively corrects to an existing or new target. */
function isAffirmativeWorkHubCorrectionRequest(value: string): boolean {
  const normalized = value.replace(/[’‘]/gu, "'");
  if (!hasWorkHubCorrectionCue(normalized)) return false;
  const affirmativeCreation =
    isExplicitWorkHubCreationRequest(normalized) &&
    (!hasWorkHubNamedCreationClause(normalized) ||
      Boolean(affirmativeWorkHubNamedCreationTitle(normalized)));
  return affirmativeCreation || isAffirmativeWorkHubExistingTargetCorrectionRequest(normalized);
}

/** Whether trusted user text contains an explicit WorkHub route-correction cue. */
function hasWorkHubCorrectionCue(value: string): boolean {
  return CORRECTION_CUE.test(value.replace(/[’‘]/gu, "'"));
}

function hasAffirmativeExecutableGrammar(
  value: string,
  actions: readonly RegExpMatchArray[],
): boolean {
  const decisions = executionActionDecisions(value);
  return (
    hasLaterCoordinatedDirectExecutableAction(value, actions, decisions) ||
    actions.some((action, index) => {
      if (action.index === undefined || decisions.get(String(index)) !== true) return false;
      const clausePrefix = afterLastDecisionReset(value.slice(0, action.index));
      const directPrefix = clausePrefix
        .replace(CORRECTION_CUE, '')
        .replace(LEADING_CORRECTION_SEPARATOR, '');
      return (
        isDirectExecutionPrefix(directPrefix) ||
        (ADVISORY_SPEECH_ACT.test(value) && hasCoordinatedDirectAction(clausePrefix)) ||
        hasImperativeCoordinatedLead(directPrefix, value.slice(action.index + action[0].length))
      );
    })
  );
}

function hasLaterCoordinatedDirectExecutableAction(
  value: string,
  actions: readonly RegExpMatchArray[],
  decisions = executionActionDecisions(value),
): boolean {
  return actions.slice(1).some((action, offset) => {
    if (action.index === undefined || decisions.get(String(offset + 1)) !== true) return false;
    const previous = actions[offset];
    if (previous?.index === undefined) return false;
    const between = value.slice(previous.index + previous[0].length, action.index);
    return COORDINATED_DIRECT_ACTION_PREFIX.test(between);
  });
}

function hasDominatingDeliberation(value: string): boolean {
  if (hasUnquotedTerminalWithdrawal(value)) return true;
  const firstAction = EXECUTION_ACTION.exec(value);
  if (firstAction?.index === undefined) return false;
  const actionTail = value.slice(firstAction.index + firstAction[0].length);
  return POST_ACTION_DELIBERATIVE.test(actionTail) || hasPostActionDeliberativeQuestion(actionTail);
}

/**
 * Advisory `how to` complements have an attachment ambiguity at a later
 * coordinator. This check can only demote to clarification; it never grants
 * execution authority.
 */
function hasAmbiguousAdvisoryCommand(value: string, actions: readonly RegExpMatchArray[]): boolean {
  if (!ADVISORY_SPEECH_ACT.test(value) || actions.length < 2) return false;
  const complementAction = actions[0];
  if (complementAction?.index === undefined) return false;
  const complementPrefix = value.slice(0, complementAction.index);
  if (!/(?:\bhow\s+to\s*|(?:如何|怎么)\s*)$/iu.test(complementPrefix)) return false;
  const decisions = executionActionDecisions(value);
  let sawBareComma = false;
  for (let index = 1; index < actions.length; index += 1) {
    const previous = actions[index - 1];
    const directAction = actions[index];
    if (previous?.index === undefined || directAction?.index === undefined) continue;
    if (decisions.get(String(index)) !== true) continue;
    const between = value.slice(previous.index + previous[0].length, directAction.index);
    const boundary = ADVISORY_MATRIX_ACTION_BOUNDARY.exec(between);
    if (!boundary) {
      sawBareComma ||= /[,，]/u.test(between);
      continue;
    }
    const hardBoundary = /[.;。；]/u.test(boundary[0]);
    const priorBareComma = sawBareComma || /[,，]/u.test(between.slice(0, boundary.index));
    if (priorBareComma && !hardBoundary) {
      sawBareComma = true;
      continue;
    }
    const directTail = value.slice(directAction.index + directAction[0].length);
    if (isLikelyDeclarativeActionTail(directTail)) continue;
    return true;
  }
  return false;
}

function hasImperativeCoordinatedLead(value: string, actionTail: string): boolean {
  const normalized = value.trim();
  if (!isBoundedPreparatoryActionTail(actionTail)) return false;
  return /^(?:(?:(?:please|kindly|first|next)\s+)|(?:先|接下来)\s*)*(?:(?:investigate|analy[sz]e|debug|review|inspect|audit|research|triage|assess|examine)(?:\s+[^,.;!?，。；！？]{0,80})?(?:(?:,\s*)?(?:and\s+then|then|and))|(?:调查|分析|排查|审查|评估|研究)(?:[^,.;!?，。；！？]{0,48})?(?:(?:，\s*)?(?:并且|并|然后)))\s*$/iu.test(
    normalized,
  );
}

function isLikelyDeclarativeActionTail(value: string): boolean {
  const unquoted = maskLiteralSpans(value).value;
  const words = unquoted
    .replace(/[.!?。！？]+\s*$/u, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (
    /(?:仍然|都很|都已|很重要|附上|可用)/u.test(unquoted) ||
    (/(?:已经|正在)/u.test(unquoted) && !/^\s*(?:已经|正在).{1,24}的/u.test(unquoted))
  ) {
    return true;
  }
  if (words.length < 2) return false;
  const startsWithDeterminer = /^(?:the|a|an|both|this|that|these|those|my|our|your)\b/iu.test(
    words[0] ?? '',
  );
  if (
    words
      .slice(1)
      .some((word) =>
        /^(?:is|are|was|were|has|have|will|would|can|could|should|must|remain|remains|seem|seems|look|looks)$/iu.test(
          word,
        ),
      )
  ) {
    return true;
  }
  return (
    /^(?:matter|matters|changed|changes|improved|improves|increased|increases|failed|fails|succeeded|succeeds|exists|exist)$/iu.test(
      words.at(-1) ?? '',
    ) ||
    (!startsWithDeterminer && words.slice(1).some((word) => /ed$/iu.test(word)))
  );
}

function isBoundedPreparatoryActionTail(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/[.!?。！？]+\s*$/u, '')
    .trim();
  if (!normalized) return false;
  if (/^[\p{Script=Han}][\p{Script=Han}\p{L}\p{N}_-]{0,48}$/u.test(normalized)) {
    return !isLikelyDeclarativeActionTail(normalized);
  }
  if (isLikelyDeclarativeActionTail(normalized)) return false;
  return /^(?:(?:the|a|an|both|this|that|these|those|my|our|your)\s+)?[\p{L}\p{N}_.:/-]+(?:\s+[\p{L}\p{N}_.:/-]+){0,5}(?:\s+(?:for|in|on|with|without|before|after|under)\s+[\p{L}\p{N}_.:/-]+(?:\s+[\p{L}\p{N}_.:/-]+){0,3})?$/iu.test(
    normalized,
  );
}

function maskLiteralSpans(value: string): { readonly value: string; readonly malformed: boolean } {
  const scope = buildLiteralScope(value);
  return {
    value: value
      .split('')
      .map((character, index) => (scope.contains(index) ? ' ' : character))
      .join(''),
    malformed: scope.malformed,
  };
}

function buildLiteralScope(value: string): {
  readonly contains: (index: number) => boolean;
  readonly malformed: boolean;
} {
  const covered = new Uint8Array(value.length);
  const bracketClosers = new Map([
    ['(', ')'],
    ['（', '）'],
    ['[', ']'],
    ['【', '】'],
  ]);
  const quoteClosers = new Map([
    ['"', '"'],
    ['“', '”'],
    ['‘', '’'],
    ['`', '`'],
  ]);
  const bracketClosingCharacters = new Set(bracketClosers.values());
  const brackets: string[] = [];
  let quote: string | undefined;
  let malformed = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (quote) {
      covered[index] = 1;
      if (character === quote) quote = undefined;
      continue;
    }
    if (brackets.length > 0) {
      covered[index] = 1;
      const nested = bracketClosers.get(character);
      if (nested) brackets.push(nested);
      else if (character === brackets.at(-1)) brackets.pop();
      else if (bracketClosingCharacters.has(character)) malformed = true;
      continue;
    }
    const quoteCloser = quoteClosers.get(character);
    if (quoteCloser) {
      covered[index] = 1;
      quote = quoteCloser;
      continue;
    }
    const bracketCloser = bracketClosers.get(character);
    if (bracketCloser) {
      covered[index] = 1;
      brackets.push(bracketCloser);
      continue;
    }
    if (bracketClosingCharacters.has(character) || character === '”') {
      malformed = true;
    }
  }
  malformed ||= Boolean(quote || brackets.length > 0);
  return {
    contains: (index) => covered[index] === 1,
    malformed,
  };
}

function isDeliberative(value: string): boolean {
  const firstAction = EXECUTION_ACTION.exec(value);
  const actionPrefix = firstAction?.index === undefined ? '' : value.slice(0, firstAction.index);
  const directActionPrefix = actionPrefix
    .replace(CORRECTION_CUE, '')
    .replace(LEADING_CORRECTION_SEPARATOR, '');
  const actionTail =
    firstAction?.index === undefined ? '' : value.slice(firstAction.index + firstAction[0].length);
  const hasDeliberativeLead =
    firstAction?.index !== undefined &&
    firstAction.index > 0 &&
    !isDirectExecutionPrefix(directActionPrefix) &&
    !hasCoordinatedDirectAction(actionPrefix) &&
    (DELIBERATIVE_LEAD_MARKER.test(actionPrefix) ||
      ADVISORY_COMPLEMENT_NOUN.test(actionPrefix) ||
      (/(?:告诉我|给我)/u.test(actionPrefix) &&
        /(?:的?(?:步骤|方法|方式)|怎么做)/u.test(actionTail)));
  const hasAdvisoryComplement =
    firstAction?.index !== undefined &&
    ADVISORY_COMPLEMENT_NOUN.test(actionPrefix) &&
    ADVISORY_COMPLEMENT_RELATIVE.test(actionPrefix);
  return (
    DELIBERATIVE_REQUEST.test(value) ||
    hasAdvisoryComplement ||
    (ADVISORY_SPEECH_ACT.test(value) && !hasCoordinatedDirectAction(actionPrefix)) ||
    hasDeliberativeLead ||
    (firstAction?.index !== undefined && POST_ACTION_DELIBERATIVE.test(actionTail)) ||
    (firstAction?.index !== undefined && hasPostActionDeliberativeQuestion(actionTail)) ||
    (TRAILING_QUESTION.test(value) &&
      (firstAction?.index === undefined ||
        !isDirectExecutionPrefix(directActionPrefix) ||
        POST_ACTION_QUESTION_ALTERNATIVE.test(actionTail)))
  );
}

function hasCoordinatedDirectAction(value: string): boolean {
  if (COORDINATED_DIRECT_ACTION_PREFIX.test(value)) return true;
  return BARE_COORDINATED_ACTION_PREFIX.test(value);
}

function hasPostActionDeliberativeQuestion(value: string): boolean {
  if (!TRAILING_QUESTION.test(value)) return false;
  if (POST_ACTION_EMBEDDED_QUESTION.test(value) && !UNQUOTED_LITERAL_QUESTION_TARGET.test(value)) {
    return true;
  }
  const body = value.replace(/[?？]\s*$/u, '');
  const boundary = allMatches(body, /[,.!?;:—–，。！？；：]/u).at(-1);
  if (boundary?.index === undefined) return false;
  const question = body.slice(boundary.index + boundary[0].length).trim();
  const requiresQuestionLead = /[,，]/u.test(boundary[0]);
  return Boolean(
    question &&
      (!requiresQuestionLead ||
        POST_ACTION_QUESTION_CLAUSE_LEAD.test(question) ||
        POST_ACTION_UNCERTAINTY_TAG.test(question)) &&
      !isScaffoldedDirectExecutableClause(question),
  );
}

function isDirectExecutionPrefix(value: string): boolean {
  return (
    ELLIPTICAL_CONDITIONAL_PREFIX.test(value) ||
    DIRECT_EXECUTION_PREFIX.test(value) ||
    (CONDITIONAL_EXECUTION_PREFIX.test(value) && !DELIBERATIVE_CONDITIONAL_PREFIX.test(value))
  );
}

function lastMatch(value: string, pattern: RegExp): RegExpMatchArray | undefined {
  const matches = allMatches(value, pattern);
  return matches.at(-1);
}

function allMatches(value: string, pattern: RegExp): RegExpMatchArray[] {
  return [...value.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
}

function lastBoundaryEnd(value: string, pattern: RegExp): number {
  return allMatches(value, pattern).reduce(
    (latest, match) =>
      match.index === undefined ? latest : Math.max(latest, match.index + match[0].length),
    0,
  );
}

function executionActionDecisions(value: string): ReadonlyMap<string, boolean> {
  const decisions = new Map<string, boolean>();
  const actions = allMatches(value, EXECUTION_ACTION);
  const priorActions: Array<{ id: string; key: string; target: string }> = [];
  let previous: RegExpMatchArray | undefined;
  let previousDecision: boolean | undefined;
  for (const [index, action] of actions.entries()) {
    if (action.index === undefined) continue;
    const previousEnd = previous?.index === undefined ? 0 : previous.index + previous[0].length;
    const prefix = value.slice(previousEnd, action.index);
    if (ANAPHORIC_CANCELLATION.test(prefix)) {
      withdrawAll(decisions);
      previousDecision = false;
    }
    const reset = hasDecisionReset(prefix);
    const decision = NEGATOR.test(afterLastDecisionReset(prefix))
      ? false
      : previousDecision === false && !reset
        ? false
        : true;
    const id = String(index);
    const key = action[0].toLocaleLowerCase();
    const target = actionObject(value, action, actions[index + 1]);
    if (decision === false) {
      if (hasAnaphoricObjectAfter(value, action, actions[index + 1])) {
        withdrawAll(decisions);
      } else if (target) {
        for (const prior of priorActions) {
          if (prior.key === key && sameActionTarget(prior.target, target)) {
            decisions.set(prior.id, false);
          }
        }
      }
    }
    decisions.set(id, decision);
    priorActions.push({ id, key, target });
    previous = action;
    previousDecision = decision;
  }
  if (previous?.index !== undefined) {
    const trailing = value.slice(previous.index + previous[0].length);
    if (ANAPHORIC_CANCELLATION.test(trailing) || hasBareTrailingCancellation(value)) {
      withdrawAll(decisions);
    }
  }
  return decisions;
}

function hasBareTrailingCancellation(value: string): boolean {
  const match = BARE_TRAILING_CANCELLATION.exec(value);
  if (!match || match.index === undefined) return false;
  const boundary = match[1] ?? '';
  const horizontalWhitespace = match[2] ?? '';
  const prefix = value.slice(0, match.index);
  if (isMultilineLiteral(prefix, boundary, horizontalWhitespace)) return false;
  const prefixWithBoundary = prefix + boundary;
  if (!ABBREVIATION_BEFORE_BOUNDARY.test(prefixWithBoundary)) return true;
  return boundary === '.' && /^[A-Z]/u.test(match[3] ?? '');
}

function isMultilineLiteral(
  prefix: string,
  boundary: string,
  horizontalWhitespace: string,
): boolean {
  const currentLine = prefix.slice(
    Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r')) + 1,
  );
  if (/[\r\n]/u.test(boundary) && /[\r\n]$/u.test(prefix)) return false;
  const lines = prefix.split(/\r\n|[\r\n]/u);
  if (!/[\r\n]/u.test(boundary) && !lines.at(-1)) lines.pop();
  if (boundary === '-' && !/\s$/u.test(prefix)) return true;
  const structuralLiteral =
    (boundary === '-' && !currentLine.trim()) ||
    (boundary === '.' && /^\s*\d+$/u.test(currentLine)) ||
    (/[\r\n]/u.test(boundary) &&
      (/\t/u.test(horizontalWhitespace) || horizontalWhitespace.length >= 4));
  if (structuralLiteral) {
    if (boundary === '.' && lines.at(-1)?.trim() === currentLine.trim()) lines.pop();
    return hasValidatedStructuralLiteralContext(lines);
  }
  if (!/[\r\n]/u.test(boundary)) return false;
  return hasValidatedColonLiteralContext(lines);
}

function hasValidatedStructuralLiteralContext(lines: readonly string[]): boolean {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const rawLine = lines[index] ?? '';
    if (!rawLine.trim()) return false;
    if (PRIOR_STRUCTURED_LITERAL_ITEM.test(rawLine)) continue;
    const line = normalizeMarkdownLine(rawLine);
    if (!line) return false;
    if (STRUCTURED_LITERAL_LINE.test(line)) continue;
    if (MULTILINE_LITERAL_INTRODUCER.test(line)) return isExecutableLiteralIntroducer(line);
    return isExecutableLiteralContext(line);
  }
  return false;
}

function hasValidatedColonLiteralContext(lines: readonly string[]): boolean {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = normalizeMarkdownLine(lines[index] ?? '');
    if (!line) return false;
    if (MULTILINE_LITERAL_INTRODUCER.test(line)) return isExecutableLiteralIntroducer(line);
  }
  return false;
}

function normalizeMarkdownLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^(\*{1,3}|_{1,3})(.*)\1$/u, '$2')
    .trim();
}

function isExecutableLiteralIntroducer(line: string): boolean {
  const content = line.replace(MULTILINE_LITERAL_INTRODUCER, '').trim();
  return isExecutableLiteralContext(content);
}

function isExecutableLiteralContext(content: string): boolean {
  const action = EXECUTION_ACTION.exec(content);
  const actionPrefix = action?.index === undefined ? '' : content.slice(0, action.index).trim();
  const target =
    action?.index === undefined ? '' : content.slice(action.index + action[0].length).trim();
  if (ACTION_INTRODUCER_PREFIX.test(actionPrefix) && target && !/^(?:to|为)$/iu.test(target)) {
    return true;
  }
  return EXACT_LITERAL_HEADER.test(content);
}

function hasNegatedAnaphoricCreation(value: string, explicitCreation: RegExpMatchArray): boolean {
  if (explicitCreation.index === undefined) return false;
  const offset = explicitCreation.index + explicitCreation[0].length;
  const trailing = value.slice(offset);
  let previousEnd = 0;
  for (const action of allMatches(trailing, CREATION_ACTION)) {
    if (action.index === undefined) continue;
    const prefix = trailing.slice(previousEnd, action.index);
    const after = trailing.slice(action.index + action[0].length);
    if (NEGATOR.test(prefix) && ANAPHORIC_OBJECT.test(after)) return true;
    previousEnd = action.index + action[0].length;
  }
  return false;
}

function hasAnaphoricObjectAfter(
  value: string,
  action: RegExpMatchArray,
  next: RegExpMatchArray | undefined,
): boolean {
  if (action.index === undefined) return false;
  const end = next?.index ?? value.length;
  return ANAPHORIC_OBJECT.test(value.slice(action.index + action[0].length, end));
}

function actionObject(
  value: string,
  action: RegExpMatchArray,
  next: RegExpMatchArray | undefined,
): string {
  if (action.index === undefined) return '';
  const end = next?.index ?? value.length;
  const trailing = value.slice(action.index + action[0].length, end);
  const cutters = [
    ...allMatches(trailing, HARD_CLAUSE_BOUNDARY),
    ...allMatches(trailing, SOFT_CLAUSE_BOUNDARY),
    ...allMatches(trailing, POSITIVE_CONTRAST),
    ...allMatches(trailing, NEGATOR),
  ];
  const cut = cutters.reduce(
    (earliest, match) => (match.index === undefined ? earliest : Math.min(earliest, match.index)),
    trailing.length,
  );
  return trailing
    .slice(0, cut)
    .trim()
    .replace(/^(?:a|an|the)\s+/iu, '')
    .replace(
      /(?:(?:\s+\b(?:and|then|also|please|kindly)\b)|(?:并且|并|且|然后|随后|请|麻烦))+\s*$/iu,
      '',
    )
    .toLocaleLowerCase();
}

function isMatchNegated(value: string, match: RegExpMatchArray): boolean {
  if (match.index === undefined) return false;
  return NEGATOR.test(afterLastDecisionReset(value.slice(0, match.index)));
}

function sameActionTarget(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  if (!left.startsWith(right)) return false;
  const remainder = left.slice(right.length);
  return ACTION_TARGET_SCAFFOLDING.test(remainder);
}

function withdrawAll(decisions: Map<string, boolean>): void {
  for (const key of decisions.keys()) decisions.set(key, false);
}

function hasDecisionReset(value: string): boolean {
  return HARD_CLAUSE_BOUNDARY.test(value) || POSITIVE_CONTRAST.test(value);
}

function afterLastDecisionReset(value: string): string {
  const resets = [
    ...allMatches(value, HARD_CLAUSE_BOUNDARY),
    ...allMatches(value, POSITIVE_CONTRAST),
  ];
  const lastReset = resets.reduce(
    (latest, match) =>
      match.index === undefined ? latest : Math.max(latest, match.index + match[0].length),
    0,
  );
  return value.slice(lastReset);
}
