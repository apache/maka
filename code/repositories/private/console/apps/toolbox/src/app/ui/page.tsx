"use client";
import * as React from "react";
import {
  Alert, AlertTitle, AlertDescription,
  Badge,
  Accordion, AccordionItem, AccordionTrigger, AccordionContent,
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
  Avatar, AvatarFallback,
  BackToTop,
  Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator, BreadcrumbPage,
  Button,
  Calendar,
  Card, CardContent, CardHeader, CardTitle,
  Carousel,
  Checkbox,
  Descriptions, DescriptionsItem,
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
  Divider,
  Drawer, DrawerTrigger, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  Empty,
  Form, FormField, FormLabel, FormControl, FormDescription,
  Input,
  Menu,
  MessageHost,
  Pagination,
  Popover, PopoverTrigger, PopoverContent,
  Progress,
  RadioGroup, RadioGroupItem,
  Rate,
  Result,
  Segmented,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Skeleton, Spinner,
  Slider,
  Steps,
  Switch,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Tabs, TabsContent, TabsList, TabsTrigger,
  Textarea,
  Timeline, TimelineItem, TimelineContent, TimelineTime,
  Title, Text, Quote, Code,
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
  Transfer,
  Tree,
  Upload, UploadList,
  useMessage,
} from "@ggbdpq/console-ui";

// /ui 全量展示页：每个组件一段 live demo（对位 ant-design / element-plus 核心清单）

const demoTree = [
  { id: "1", label: "src", children: [
    { id: "1-1", label: "app", children: [{ id: "1-1-1", label: "page.tsx" }, { id: "1-1-2", label: "layout.tsx" }] },
    { id: "1-2", label: "server" },
  ] },
  { id: "2", label: "package.json" },
];

const transferItems = ["React", "TypeScript", "Vite", "Next.js", "Tailwind", "Zustand"].map((s, i) => ({ id: String(i), label: s }));

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="border-b pb-2 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default function UiShowcasePage() {
  const { show, host } = useMessage();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [tab, setTab] = React.useState<"list" | "card">("list");
  const [page, setPage] = React.useState(2);
  const [transferTarget, setTransferTarget] = React.useState<string[]>(["0", "1"]);
  const [files, setFiles] = React.useState<File[]>([]);
  const [switchOn, setSwitchOn] = React.useState(true);
  const [slider, setSlider] = React.useState(40);
  const [rate, setRate] = React.useState(4);
  const [selectedMenu, setSelectedMenu] = React.useState("home");

  return (
    <TooltipProvider>
      {host}
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">组件陈列室</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          @ggbdpq/console-ui 共 46 个导出组件（12 个一期 + 34 个本期），API 对位 ant-design / element-plus 核心清单
        </p>
      </header>

      <div className="space-y-10">
        <Section title="Button / Badge / Avatar / Tag 体系">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
          </div>
          <div className="flex items-center gap-3">
            <Avatar><AvatarFallback>gg</AvatarFallback></Avatar>
            <Avatar><AvatarFallback className="bg-primary text-primary-foreground">关</AvatarFallback></Avatar>
          </div>
        </Section>

        <Section title="Typography 文字排版">
          <div className="space-y-2">
            <Title level={3}>三级标题 Title</Title>
            <Text>Text 正文：日拱一卒，功不唐捐。</Text>
            <Quote>Quote 引用：工具链的进步，最终是为了让人专注业务逻辑本身。</Quote>
            <Text>行内 <Code>Code</Code> 片段。</Text>
          </div>
        </Section>

        <Section title="表单控件">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <Input placeholder="Input 输入框" />
              <Textarea placeholder="Textarea 多行文本" />
              <Select>
                <SelectTrigger><SelectValue placeholder="Select 选择器" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="a">选项 A</SelectItem>
                  <SelectItem value="b">选项 B</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox id="demo-cb" defaultChecked /> Checkbox
              </label>
              <RadioGroup defaultValue="r1" className="flex gap-4">
                {["r1", "r2"].map((v) => (
                  <label key={v} className="flex items-center gap-1.5 text-sm">
                    <RadioGroupItem value={v} /> Radio {v}
                  </label>
                ))}
              </RadioGroup>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={switchOn} onCheckedChange={setSwitchOn} /> Switch（{switchOn ? "开" : "关"}）
              </label>
              <div>
                <div className="mb-1 text-sm">Slider：{slider}</div>
                <Slider value={[slider]} onValueChange={([v]) => setSlider(v)} max={100} step={1} />
              </div>
              <div>
                <div className="mb-1 text-sm">Rate 评分</div>
                <Rate value={rate} onChange={setRate} />
              </div>
            </div>
          </div>
          <Form>
            <FormField>
              <FormLabel>Form 组合层</FormLabel>
              <FormControl><Input placeholder="表单字段" /></FormControl>
              <FormDescription>FormDescription 描述文字，校验交给 zod。</FormDescription>
            </FormField>
          </Form>
        </Section>

        <Section title="反馈">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => show("info", "这是一条 info 消息")}>Message info</Button>
              <Button variant="outline" onClick={() => show("success", "操作成功")}>Message success</Button>
              <Button variant="outline" onClick={() => show("error", "出错了")}>Message error</Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Alert variant="info">
                <AlertTitle>Alert info</AlertTitle>
                <AlertDescription>提示性内容，四种语义色可选。</AlertDescription>
              </Alert>
              <Alert variant="warning">
                <AlertTitle>Alert warning</AlertTitle>
                <AlertDescription>警告内容。</AlertDescription>
              </Alert>
            </div>
            <div className="flex items-center gap-3">
              <Progress value={60} className="max-w-xs" />
              <span className="text-sm text-muted-foreground">Progress 60%</span>
              <Spinner />
              <span className="text-sm text-muted-foreground">Spinner</span>
            </div>
            <div className="flex gap-3">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
            <Result status="success" title="提交成功" subTitle="Result 组件：状态 + 标题 + 副文案" />
          </div>
        </Section>

        <Section title="浮层">
          <div className="flex flex-wrap gap-2">
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild><Button variant="outline">Dialog 模态框</Button></DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>DialogTitle</DialogTitle>
                  <DialogDescription>DialogDescription 描述</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button onClick={() => setDialogOpen(false)}>知道了</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
              <DrawerTrigger asChild><Button variant="outline">Drawer 侧滑抽屉</Button></DrawerTrigger>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>DrawerTitle</DrawerTitle>
                  <DrawerDescription>右侧滑出的抽屉</DrawerDescription>
                </DrawerHeader>
                <p className="text-sm text-muted-foreground">内容区</p>
                <DrawerFooter>
                  <DrawerClose asChild><Button variant="outline">关闭</Button></DrawerClose>
                </DrawerFooter>
              </DrawerContent>
            </Drawer>
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="outline">AlertDialog 确认框</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认删除？</AlertDialogTitle>
                  <AlertDialogDescription>此操作不可撤销。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction>确认</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Popover>
              <PopoverTrigger asChild><Button variant="outline">Popover 气泡卡片</Button></PopoverTrigger>
              <PopoverContent>PopoverContent 气泡内容</PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline">DropdownMenu</Button></DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>分组标题</DropdownMenuLabel>
                <DropdownMenuItem>动作一</DropdownMenuItem>
                <DropdownMenuItem>动作二</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive">危险动作</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild><Button variant="ghost">Tooltip</Button></TooltipTrigger>
              <TooltipContent>悬停提示</TooltipContent>
            </Tooltip>
          </div>
          <Accordion type="single" collapsible className="rounded-lg border px-4">
            <AccordionItem value="a">
              <AccordionTrigger>Accordion 手风琴</AccordionTrigger>
              <AccordionContent>展开的内容区。</AccordionContent>
            </AccordionItem>
            <AccordionItem value="b">
              <AccordionTrigger>第二项</AccordionTrigger>
              <AccordionContent>内容 B。</AccordionContent>
            </AccordionItem>
          </Accordion>
        </Section>

        <Section title="导航">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem><BreadcrumbLink href="#">首页</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbLink href="#">列表</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbPage>当前页</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="flex flex-wrap items-start gap-8">
            <Menu
              items={[{ key: "home", label: "首页" }, { key: "list", label: "列表页" }, { key: "about", label: "关于", disabled: true }]}
              selectedKey={selectedMenu}
              onSelect={setSelectedMenu}
              className="w-40 rounded-lg border p-2"
            />
            <Steps current={1} items={["填写信息", "确认订单", "支付", "完成"]} className="max-w-md" />
          </div>
          <Segmented
            options={[{ value: "list", label: "列表" }, { value: "card", label: "卡片" }]}
            value={tab}
            onChange={setTab}
          />
          <Pagination current={page} total={87} onChange={setPage} />
        </Section>

        <Section title="数据展示">
          <Tabs defaultValue="t1">
            <TabsList>
              <TabsTrigger value="t1">Tabs 一</TabsTrigger>
              <TabsTrigger value="t2">Tabs 二</TabsTrigger>
            </TabsList>
            <TabsContent value="t1" className="pt-3 text-sm text-muted-foreground">第一个标签页内容。</TabsContent>
            <TabsContent value="t2" className="pt-3 text-sm text-muted-foreground">第二个标签页内容。</TabsContent>
          </Tabs>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Card 卡片</CardTitle></CardHeader>
              <CardContent className="text-sm text-muted-foreground">卡片内容区。</CardContent>
            </Card>
            <Descriptions title="Descriptions 描述列表">
              <DescriptionsItem label="作者">ggbdpq</DescriptionsItem>
              <DescriptionsItem label="栈">React 19 + TS 7</DescriptionsItem>
            </Descriptions>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>题目</TableHead>
                  <TableHead>难度</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell>两数之和</TableCell><TableCell>简单</TableCell></TableRow>
                <TableRow><TableCell>字符串相加</TableCell><TableCell>简单</TableCell></TableRow>
              </TableBody>
            </Table>
            <Timeline>
              <TimelineItem>
                <TimelineContent>创建仓库</TimelineContent>
                <TimelineTime>2026-08-01</TimelineTime>
              </TimelineItem>
              <TimelineItem>
                <TimelineContent>首个版本发布</TimelineContent>
                <TimelineTime>2026-08-30</TimelineTime>
              </TimelineItem>
            </Timeline>
            <Tree data={demoTree} defaultExpandedIds={["1"]} className="rounded-lg border p-3" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Carousel items={["第 1 帧", "第 2 帧", "第 3 帧"]} />
            <div>
              <Calendar onChange={(d) => show("info", `选中 ${d.toLocaleDateString("zh-CN")}`)} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Transfer items={transferItems} target={transferTarget} onChange={setTransferTarget} />
            <div>
              <Upload onFiles={setFiles} multiple />
              <UploadList files={files} onRemove={(name) => setFiles(files.filter((f) => f.name !== name))} />
            </div>
          </div>
          <Empty>
            <p className="text-sm text-muted-foreground">Empty 空状态</p>
          </Empty>
        </Section>

        <Section title="其他">
          <p className="text-sm text-muted-foreground">BackToTop 回到顶部按钮在页面右下角（滚过一屏出现）。</p>
        </Section>
      </div>
      <BackToTop />
    </TooltipProvider>
  );
}
