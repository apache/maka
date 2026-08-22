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

/**
 * Centralized icon re-export — the single seam between Maka call sites
 * and the underlying generic UI icon library.
 *
 * Business code imports icons from `@maka/ui/icons`; this file decides
 * which icon set backs those names. Generic UI icons now come directly
 * from `lucide-react`. Bot/channel brand logos live in
 * `bot-brand-logo.tsx` because they are fixed product assets, not generic
 * UI icons.
 */

export type { LucideIcon, LucideProps } from 'lucide-react';

/**
 * The five-rung icon scale. Pick by the role the glyph plays, not by eye.
 *
 * A size has to be passed at every lucide call site: Astryx's `sm` button
 * bounds the icon slot at 16px (Button.tsx's `iconSizeStyles`) but does not
 * resize the glyph inside it, so an unsized lucide icon keeps its own 24px
 * height and renders 16×24, squashed. `chrome` (16) exactly fills that slot;
 * the other rungs sit around it. Mirrored as `--icon-*` in maka-tokens.css
 * for the CSS-clamped sites.
 */
export const ICON_SIZE = {
  meta: 13,    // inline with text: dense metadata, markers, badge glyphs
  control: 14, // row icons, IconButton sm, toolbars, list startContent
  chrome: 16,  // nav/affordance chrome; == Astryx Icon sm / Button sm icon slot
  empty: 20,   // EmptyState glyphs (DESIGN.md §10 tier 2/3)
  plate: 28,   // glyph inside an icon plate or hero mark
} as const;

export {
  Accessibility,
  Activity,
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Ban,
  BarChart3,
  Bell,
  Blocks,
  BookOpen,
  Bot,
  Brain,
  CalendarCheck,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronRightIcon,
  CircleCheckBig,
  CircleGauge,
  Clipboard,
  Clock,
  Copy,
  CornerDownLeft,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  FileCode,
  FileEdit,
  FileImage,
  FileText,
  FileType,
  Flag,
  FolderOpen,
  FolderGit2,
  GitBranch,
  GitMerge,
  Globe,
  Grid3X3,
  HelpCircle,
  History,
  Hourglass,
  Info,
  KeyRound,
  Keyboard,
  LineChart,
  ListFilter,
  ListTodo,
  Loader2,
  Loader2Icon,
  MessageCircleQuestion,
  MessageSquare,
  Mic,
  Maximize2,
  Minus,
  Minimize2,
  Monitor,
  Moon,
  MoreHorizontal,
  MousePointer2,
  Network,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plug,
  Plus,
  RefreshCcw,
  Repeat,
  RotateCcw,
  RotateCw,
  Scan,
  Save,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  SquarePen,
  Sun,
  SunMoon,
  Target,
  Terminal,
  TextQuote,
  Timer,
  Trash2,
  Upload,
  User,
  Volume2,
  Wifi,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
