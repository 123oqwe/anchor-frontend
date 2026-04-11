import { useState } from "react";
import { motion } from "framer-motion";
import {
  Settings as SettingsIcon,
  User,
  Shield,
  Bell,
  Palette,
  Brain,
  Key,
  Globe,
  Zap,
  ChevronRight,
  Moon,
  Sun,
  Monitor,
  Save,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

const modelTiers = [
  { name: "GPT-4o", provider: "OpenAI", tier: "reasoning", status: "active", cost: "$$" },
  { name: "Claude 3.5 Sonnet", provider: "Anthropic", tier: "reasoning", status: "available", cost: "$$" },
  { name: "GPT-4o-mini", provider: "OpenAI", tier: "fast", status: "active", cost: "$" },
  { name: "Gemini 1.5 Flash", provider: "Google", tier: "fast", status: "available", cost: "$" },
  { name: "Local (Ollama)", provider: "Self-hosted", tier: "private", status: "not configured", cost: "Free" },
];

const settingSections = [
  { id: "profile", label: "Profile", icon: User },
  { id: "models", label: "AI Models", icon: Brain },
  { id: "privacy", label: "Privacy & Trust", icon: Shield },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "integrations", label: "Integrations", icon: Globe },
  { id: "api", label: "API Keys", icon: Key },
];

export default function Settings() {
  const [activeSection, setActiveSection] = useState("profile");
  const [profileName, setProfileName] = useState("Alex Chen");
  const [profileEmail, setProfileEmail] = useState("alex@anchor.dev");
  const [profileRole, setProfileRole] = useState("Founder & CEO");
  const [notifications, setNotifications] = useState({
    decisions: true,
    memories: true,
    twinAlerts: true,
    weeklyDigest: true,
    emailNotifications: false,
  });
  const [privacy, setPrivacy] = useState({
    localProcessing: false,
    dataRetention: "90",
    shareAnalytics: false,
    encryptMemory: true,
  });
  const [appearance, setAppearance] = useState<"dark" | "light" | "system">("dark");

  const handleSave = () => {
    toast.success("Settings saved successfully");
  };

  return (
    <div className="min-h-screen dot-grid">
      {/* Header */}
      <div className="px-8 pt-8 pb-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <div className="flex items-center gap-2 mb-4">
            <SettingsIcon className="h-4 w-4 text-primary" />
            <span className="text-xs font-medium text-primary tracking-wider uppercase">Settings</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Preferences</h1>
          <p className="text-sm text-muted-foreground">
            Configure your Anchor experience. Every setting respects your autonomy.
          </p>
        </motion.div>
      </div>

      <div className="px-8 pb-8">
        <div className="flex gap-6">
          {/* Settings sidebar */}
          <nav className="w-52 shrink-0 space-y-1">
            {settingSections.map((section) => {
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                    activeSection === section.id
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {section.label}
                </button>
              );
            })}
          </nav>

          {/* Settings content */}
          <div className="flex-1 max-w-2xl">
            {activeSection === "profile" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-4">Profile Information</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs text-muted-foreground font-medium block mb-1.5">Full Name</label>
                      <input
                        type="text"
                        value={profileName}
                        onChange={(e) => setProfileName(e.target.value)}
                        className="w-full glass rounded-lg px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary/30"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground font-medium block mb-1.5">Email</label>
                      <input
                        type="email"
                        value={profileEmail}
                        onChange={(e) => setProfileEmail(e.target.value)}
                        className="w-full glass rounded-lg px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary/30"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground font-medium block mb-1.5">Role</label>
                      <input
                        type="text"
                        value={profileRole}
                        onChange={(e) => setProfileRole(e.target.value)}
                        className="w-full glass rounded-lg px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary/30"
                      />
                    </div>
                  </div>
                  <button
                    onClick={handleSave}
                    className="mt-4 flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                  >
                    <Save className="h-4 w-4" />
                    Save Changes
                  </button>
                </div>

                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">Account</h2>
                  <p className="text-xs text-muted-foreground mb-4">Manage your account and data</p>
                  <div className="space-y-3">
                    <button className="w-full flex items-center justify-between glass rounded-lg px-4 py-3 text-sm text-foreground hover:bg-white/[0.07] transition-colors">
                      <span>Export all data</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                    <button className="w-full flex items-center justify-between glass rounded-lg px-4 py-3 text-sm text-red-400 hover:bg-red-500/5 transition-colors">
                      <span>Delete account</span>
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {activeSection === "models" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">AI Model Configuration</h2>
                  <p className="text-xs text-muted-foreground mb-4">
                    Choose which models power different parts of Anchor. The system automatically routes tasks to the optimal model based on complexity.
                  </p>
                  <div className="space-y-3">
                    {modelTiers.map((model) => (
                      <div key={model.name} className="flex items-center justify-between glass rounded-lg px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Zap className={`h-4 w-4 ${
                            model.status === "active" ? "text-emerald-400" :
                            model.status === "available" ? "text-muted-foreground" :
                            "text-muted-foreground/30"
                          }`} />
                          <div>
                            <span className="text-sm font-medium text-foreground">{model.name}</span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[10px] text-muted-foreground">{model.provider}</span>
                              <Badge className={`text-[9px] ${
                                model.tier === "reasoning" ? "bg-purple-500/10 text-purple-400" :
                                model.tier === "fast" ? "bg-blue-500/10 text-blue-400" :
                                "bg-emerald-500/10 text-emerald-400"
                              }`}>
                                {model.tier}
                              </Badge>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-mono text-muted-foreground">{model.cost}</span>
                          <Badge className={`text-[10px] ${
                            model.status === "active" ? "bg-emerald-500/10 text-emerald-400" :
                            model.status === "available" ? "bg-muted text-muted-foreground" :
                            "bg-muted text-muted-foreground/50"
                          }`}>
                            {model.status}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">Routing Strategy</h2>
                  <p className="text-xs text-muted-foreground mb-4">
                    How Anchor decides which model to use for each task
                  </p>
                  <div className="space-y-3">
                    {[
                      { label: "Auto (Recommended)", desc: "System chooses based on task complexity and cost", active: true },
                      { label: "Always Reasoning", desc: "Use reasoning-tier models for everything", active: false },
                      { label: "Cost Optimized", desc: "Prefer fast/cheap models, escalate only when needed", active: false },
                      { label: "Privacy First", desc: "Prefer local models, use cloud only as fallback", active: false },
                    ].map((strategy) => (
                      <div
                        key={strategy.label}
                        className={`flex items-center justify-between glass rounded-lg px-4 py-3 cursor-pointer transition-colors ${
                          strategy.active ? "border-primary/30" : "hover:bg-white/[0.03]"
                        }`}
                        style={strategy.active ? { borderWidth: "1px" } : {}}
                      >
                        <div>
                          <span className="text-sm font-medium text-foreground">{strategy.label}</span>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{strategy.desc}</p>
                        </div>
                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                          strategy.active ? "border-primary" : "border-muted-foreground/30"
                        }`}>
                          {strategy.active && <div className="w-2 h-2 rounded-full bg-primary" />}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {activeSection === "privacy" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">Privacy & Trust Controls</h2>
                  <p className="text-xs text-muted-foreground mb-4">
                    Your data, your rules. Anchor is designed with privacy as a core principle.
                  </p>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-foreground">Local-first processing</span>
                        <p className="text-[10px] text-muted-foreground mt-0.5">Process sensitive data on-device when possible</p>
                      </div>
                      <Switch
                        checked={privacy.localProcessing}
                        onCheckedChange={(v) => setPrivacy((p) => ({ ...p, localProcessing: v }))}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-foreground">Encrypt memory store</span>
                        <p className="text-[10px] text-muted-foreground mt-0.5">End-to-end encrypt all stored memories</p>
                      </div>
                      <Switch
                        checked={privacy.encryptMemory}
                        onCheckedChange={(v) => setPrivacy((p) => ({ ...p, encryptMemory: v }))}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-foreground">Share anonymous analytics</span>
                        <p className="text-[10px] text-muted-foreground mt-0.5">Help improve Anchor with anonymous usage data</p>
                      </div>
                      <Switch
                        checked={privacy.shareAnalytics}
                        onCheckedChange={(v) => setPrivacy((p) => ({ ...p, shareAnalytics: v }))}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-foreground block mb-1.5">Data retention period</label>
                      <select
                        value={privacy.dataRetention}
                        onChange={(e) => setPrivacy((p) => ({ ...p, dataRetention: e.target.value }))}
                        className="glass rounded-lg px-4 py-2.5 text-sm text-foreground bg-transparent focus:outline-none"
                      >
                        <option value="30">30 days</option>
                        <option value="90">90 days</option>
                        <option value="365">1 year</option>
                        <option value="forever">Forever</option>
                      </select>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeSection === "notifications" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-4">Notification Preferences</h2>
                  <div className="space-y-4">
                    {[
                      { key: "decisions" as const, label: "Decision alerts", desc: "When the system detects a high-priority decision" },
                      { key: "memories" as const, label: "Memory updates", desc: "When new patterns or insights are discovered" },
                      { key: "twinAlerts" as const, label: "Twin Agent alerts", desc: "When your Twin detects avoidance or risk" },
                      { key: "weeklyDigest" as const, label: "Weekly digest", desc: "Summary of your week's decisions and growth" },
                      { key: "emailNotifications" as const, label: "Email notifications", desc: "Receive notifications via email" },
                    ].map((item) => (
                      <div key={item.key} className="flex items-center justify-between">
                        <div>
                          <span className="text-sm font-medium text-foreground">{item.label}</span>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{item.desc}</p>
                        </div>
                        <Switch
                          checked={notifications[item.key]}
                          onCheckedChange={(v) => setNotifications((n) => ({ ...n, [item.key]: v }))}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {activeSection === "appearance" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-4">Appearance</h2>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { value: "dark" as const, label: "Dark", icon: Moon },
                      { value: "light" as const, label: "Light", icon: Sun },
                      { value: "system" as const, label: "System", icon: Monitor },
                    ].map((theme) => {
                      const Icon = theme.icon;
                      return (
                        <button
                          key={theme.value}
                          onClick={() => setAppearance(theme.value)}
                          className={`flex flex-col items-center gap-2 glass rounded-xl p-4 transition-all ${
                            appearance === theme.value
                              ? "border-primary/30 bg-primary/5"
                              : "hover:bg-white/[0.03]"
                          }`}
                          style={appearance === theme.value ? { borderWidth: "1px" } : {}}
                        >
                          <Icon className={`h-5 w-5 ${appearance === theme.value ? "text-primary" : "text-muted-foreground"}`} />
                          <span className={`text-xs font-medium ${appearance === theme.value ? "text-primary" : "text-muted-foreground"}`}>
                            {theme.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}

            {activeSection === "integrations" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">Integrations</h2>
                  <p className="text-xs text-muted-foreground mb-4">Connect external services to enrich your Human Graph</p>
                  <div className="space-y-3">
                    {[
                      { name: "Google Calendar", status: "connected", desc: "Sync meetings and events" },
                      { name: "Gmail", status: "connected", desc: "Analyze email patterns and relationships" },
                      { name: "Notion", status: "available", desc: "Import notes and documents" },
                      { name: "Slack", status: "available", desc: "Track communication patterns" },
                      { name: "Linear", status: "available", desc: "Sync project tasks" },
                    ].map((integration) => (
                      <div key={integration.name} className="flex items-center justify-between glass rounded-lg px-4 py-3">
                        <div>
                          <span className="text-sm font-medium text-foreground">{integration.name}</span>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{integration.desc}</p>
                        </div>
                        <Badge className={`text-[10px] ${
                          integration.status === "connected"
                            ? "bg-emerald-500/10 text-emerald-400"
                            : "bg-muted text-muted-foreground"
                        }`}>
                          {integration.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {activeSection === "api" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">API Keys</h2>
                  <p className="text-xs text-muted-foreground mb-4">
                    Manage API keys for AI model providers. Keys are encrypted and stored locally.
                  </p>
                  <div className="space-y-4">
                    {[
                      { provider: "OpenAI", configured: true },
                      { provider: "Anthropic", configured: false },
                      { provider: "Google AI", configured: false },
                    ].map((key) => (
                      <div key={key.provider} className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Key className={`h-4 w-4 ${key.configured ? "text-emerald-400" : "text-muted-foreground/30"}`} />
                          <div>
                            <span className="text-sm font-medium text-foreground">{key.provider}</span>
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {key.configured ? "sk-...configured" : "Not configured"}
                            </p>
                          </div>
                        </div>
                        <button className="text-xs text-primary hover:text-primary/80 transition-colors">
                          {key.configured ? "Update" : "Add Key"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
