import { useState, useEffect } from "react";
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
  Loader2,
  Check,
  AlertCircle,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { api } from "@/lib/api";

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Profile state — loaded from API
  const [profileName, setProfileName] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  const [profileRole, setProfileRole] = useState("");

  // Settings state — loaded from API
  const [notifications, setNotifications] = useState({
    decisions: true, memories: true, twinAlerts: true, weeklyDigest: true, emailNotifications: false,
  });
  const [privacy, setPrivacy] = useState({
    localProcessing: false, dataRetention: "90", shareAnalytics: false, encryptMemory: true,
  });
  const [appearance, setAppearance] = useState<"dark" | "light" | "system">("dark");

  // Models — loaded from API
  const [cortexStatus, setCortexStatus] = useState<any>(null);

  // API Keys — loaded from API
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");

  // Load all settings from API on mount
  useEffect(() => {
    (async () => {
      try {
        const [profile, settings, cortex] = await Promise.all([
          api.getProfile(),
          api.getSettings(),
          api.getCortexStatus().catch(() => null),
        ]);

        if (profile) {
          setProfileName(profile.name ?? "");
          setProfileEmail(profile.email ?? "");
          setProfileRole(profile.role ?? "");
        }

        if (settings) {
          setNotifications({
            decisions: !!settings.notif_decisions,
            memories: !!settings.notif_memories,
            twinAlerts: !!settings.notif_twin,
            weeklyDigest: !!settings.notif_digest,
            emailNotifications: !!settings.notif_email,
          });
          setPrivacy({
            localProcessing: !!settings.local_processing,
            dataRetention: settings.data_retention ?? "90",
            shareAnalytics: !!settings.share_analytics,
            encryptMemory: settings.encrypt_memory !== 0,
          });
          setAppearance(settings.theme ?? "dark");
        }

        if (cortex) {
          setCortexStatus(cortex);
          // Extract provider key statuses for API Keys section
          const slots = cortex.providerSlots ?? [];
          setApiKeys(slots.filter((s: any) =>
            ["anthropic", "openai", "google", "deepseek", "qwen"].includes(s.id)
          ).map((s: any) => ({
            id: s.id,
            provider: s.name,
            configured: s.keySource !== "none",
            keyMasked: s.keyMasked ?? null,
          })));
        }
      } catch (err: any) {
        setError(err.message ?? "Failed to load settings");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Save profile
  const handleSaveProfile = async () => {
    setSaving(true);
    try {
      await api.updateProfile({ name: profileName, email: profileEmail, role: profileRole });
      toast.success("Profile saved");
    } catch { toast.error("Failed to save profile"); }
    finally { setSaving(false); }
  };

  // Save privacy
  const handleSavePrivacy = async (updated: typeof privacy) => {
    setPrivacy(updated);
    try {
      await api.updateSettings("privacy", {
        local_processing: updated.localProcessing ? 1 : 0,
        data_retention: updated.dataRetention,
        share_analytics: updated.shareAnalytics ? 1 : 0,
        encrypt_memory: updated.encryptMemory ? 1 : 0,
      });
    } catch { toast.error("Failed to save privacy settings"); }
  };

  // Save notifications
  const handleSaveNotifications = async (key: string, value: boolean) => {
    const updated = { ...notifications, [key]: value };
    setNotifications(updated);
    const dbMap: Record<string, string> = {
      decisions: "notif_decisions", memories: "notif_memories",
      twinAlerts: "notif_twin", weeklyDigest: "notif_digest", emailNotifications: "notif_email",
    };
    try {
      await api.updateSettings("notifications", { [dbMap[key]]: value ? 1 : 0 });
    } catch { toast.error("Failed to save notification settings"); }
  };

  // Save appearance
  const handleSaveAppearance = async (theme: "dark" | "light" | "system") => {
    setAppearance(theme);
    try {
      await api.updateSettings("appearance", { theme });
    } catch { toast.error("Failed to save appearance"); }
  };

  // Save API key
  const handleSaveKey = async (providerId: string) => {
    if (!keyInput.trim()) return;
    try {
      await api.setProviderKey(providerId, keyInput);
      setApiKeys(prev => prev.map(k => k.id === providerId ? { ...k, configured: true, keyMasked: `${keyInput.slice(0, 6)}...` } : k));
      setEditingKey(null);
      setKeyInput("");
      toast.success(`${providerId} key saved`);
    } catch { toast.error("Failed to save key"); }
  };

  // Get active models for the models section
  const activeModels = cortexStatus?.capabilities?.filter((c: any) => c.active && c.task.includes("decision") || c.task === "general_chat" || c.task === "react_execution" || c.task.includes("twin")) ?? [];

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-8 w-8 text-red-400 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <button onClick={() => window.location.reload()} className="mt-3 text-xs text-primary hover:underline">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen dot-grid">
      <div className="px-8 pt-8 pb-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <div className="flex items-center gap-2 mb-4">
            <SettingsIcon className="h-4 w-4 text-primary" />
            <span className="text-xs font-medium text-primary tracking-wider uppercase">Settings</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Preferences</h1>
          <p className="text-sm text-muted-foreground">Configure your Anchor experience. Every setting respects your autonomy.</p>
        </motion.div>
      </div>

      <div className="px-8 pb-8">
        <div className="flex gap-6">
          <nav className="w-52 shrink-0 space-y-1">
            {settingSections.map((section) => {
              const Icon = section.icon;
              return (
                <button key={section.id} onClick={() => setActiveSection(section.id)}
                  className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                    activeSection === section.id ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}>
                  <Icon className="h-4 w-4 shrink-0" />
                  {section.label}
                </button>
              );
            })}
          </nav>

          <div className="flex-1 max-w-2xl">
            {/* Profile */}
            {activeSection === "profile" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-4">Profile Information</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs text-muted-foreground font-medium block mb-1.5">Full Name</label>
                      <input type="text" value={profileName} onChange={(e) => setProfileName(e.target.value)}
                        className="w-full glass rounded-lg px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary/30" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground font-medium block mb-1.5">Email</label>
                      <input type="email" value={profileEmail} onChange={(e) => setProfileEmail(e.target.value)}
                        className="w-full glass rounded-lg px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary/30" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground font-medium block mb-1.5">Role</label>
                      <input type="text" value={profileRole} onChange={(e) => setProfileRole(e.target.value)}
                        className="w-full glass rounded-lg px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary/30" />
                    </div>
                  </div>
                  <button onClick={handleSaveProfile} disabled={saving}
                    className="mt-4 flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {saving ? "Saving..." : "Save Changes"}
                  </button>
                </div>

                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">Account</h2>
                  <p className="text-xs text-muted-foreground mb-4">Manage your account and data</p>
                  <div className="space-y-3">
                    <button onClick={() => { window.open("/api/graph/export", "_blank"); }}
                      className="w-full flex items-center justify-between glass rounded-lg px-4 py-3 text-sm text-foreground hover:bg-white/[0.07] transition-colors">
                      <span>Export all data</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* AI Models — from real Cortex API */}
            {activeSection === "models" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">AI Model Configuration</h2>
                  <p className="text-xs text-muted-foreground mb-4">
                    Models are automatically routed based on task complexity. Configure API keys in the API Keys section.
                  </p>
                  {cortexStatus?.capabilities ? (
                    <div className="space-y-3">
                      {cortexStatus.capabilities.filter((c: any) => ["decision", "general_chat", "react_execution", "twin_edit_learning", "morning_digest"].includes(c.task)).map((cap: any) => (
                        <div key={cap.task} className="flex items-center justify-between glass rounded-lg px-4 py-3">
                          <div className="flex items-center gap-3">
                            <Zap className={`h-4 w-4 ${cap.active ? "text-emerald-400" : "text-muted-foreground/30"}`} />
                            <div>
                              <span className="text-sm font-medium text-foreground">{cap.task.replace(/_/g, " ")}</span>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-[10px] text-muted-foreground">
                                  {cap.availableModels?.[0]?.name ?? "No model available"}
                                </span>
                                <Badge className="text-[9px] bg-blue-500/10 text-blue-400">{cap.preferredTier}</Badge>
                              </div>
                            </div>
                          </div>
                          <Badge className={`text-[10px] ${cap.active ? "bg-emerald-500/10 text-emerald-400" : "bg-muted text-muted-foreground/50"}`}>
                            {cap.active ? "active" : "no key"}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Could not load model status.</p>
                  )}
                </div>

                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">Active Providers</h2>
                  <div className="space-y-2">
                    {cortexStatus?.activeProviders?.length > 0 ? (
                      cortexStatus.activeProviders.map((p: any) => (
                        <div key={p.id} className="flex items-center gap-2 text-sm">
                          <Check className="h-3 w-3 text-emerald-400" />
                          <span className="text-foreground">{p.name}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-muted-foreground">No providers configured. Add API keys below.</p>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {/* Privacy */}
            {activeSection === "privacy" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">Privacy & Trust Controls</h2>
                  <p className="text-xs text-muted-foreground mb-4">Your data, your rules.</p>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-foreground">Local-first processing</span>
                        <p className="text-[10px] text-muted-foreground mt-0.5">Process sensitive data on-device when possible</p>
                      </div>
                      <Switch checked={privacy.localProcessing} onCheckedChange={(v) => handleSavePrivacy({ ...privacy, localProcessing: v })} />
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-foreground">Encrypt memory store</span>
                        <p className="text-[10px] text-muted-foreground mt-0.5">End-to-end encrypt all stored memories</p>
                      </div>
                      <Switch checked={privacy.encryptMemory} onCheckedChange={(v) => handleSavePrivacy({ ...privacy, encryptMemory: v })} />
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-foreground">Share anonymous analytics</span>
                        <p className="text-[10px] text-muted-foreground mt-0.5">Help improve Anchor with anonymous usage data</p>
                      </div>
                      <Switch checked={privacy.shareAnalytics} onCheckedChange={(v) => handleSavePrivacy({ ...privacy, shareAnalytics: v })} />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-foreground block mb-1.5">Data retention period</label>
                      <select value={privacy.dataRetention}
                        onChange={(e) => handleSavePrivacy({ ...privacy, dataRetention: e.target.value })}
                        className="glass rounded-lg px-4 py-2.5 text-sm text-foreground bg-transparent focus:outline-none">
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

            {/* Notifications */}
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
                        <Switch checked={notifications[item.key]}
                          onCheckedChange={(v) => handleSaveNotifications(item.key, v)} />
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {/* Appearance */}
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
                        <button key={theme.value} onClick={() => handleSaveAppearance(theme.value)}
                          className={`flex flex-col items-center gap-2 glass rounded-xl p-4 transition-all ${
                            appearance === theme.value ? "border-primary/30 bg-primary/5" : "hover:bg-white/[0.03]"
                          }`}
                          style={appearance === theme.value ? { borderWidth: "1px" } : {}}>
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

            {/* Integrations — honest about status */}
            {activeSection === "integrations" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">Integrations</h2>
                  <p className="text-xs text-muted-foreground mb-4">Connect external services to enrich your Human Graph</p>
                  <div className="space-y-3">
                    {[
                      { name: "Google Calendar", status: "coming soon", desc: "Sync meetings and events" },
                      { name: "Gmail", status: "coming soon", desc: "Analyze email patterns and relationships" },
                      { name: "Notion", status: "coming soon", desc: "Import notes and documents" },
                      { name: "Slack", status: "coming soon", desc: "Track communication patterns" },
                      { name: "Linear", status: "coming soon", desc: "Sync project tasks" },
                    ].map((integration) => (
                      <div key={integration.name} className="flex items-center justify-between glass rounded-lg px-4 py-3">
                        <div>
                          <span className="text-sm font-medium text-foreground">{integration.name}</span>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{integration.desc}</p>
                        </div>
                        <Badge className="text-[10px] bg-muted text-muted-foreground">{integration.status}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {/* API Keys — real, functional */}
            {activeSection === "api" && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-2">API Keys</h2>
                  <p className="text-xs text-muted-foreground mb-4">
                    Manage API keys for AI model providers. Keys are stored securely on the server.
                  </p>
                  <div className="space-y-4">
                    {apiKeys.map((key) => (
                      <div key={key.id}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <Key className={`h-4 w-4 ${key.configured ? "text-emerald-400" : "text-muted-foreground/30"}`} />
                            <div>
                              <span className="text-sm font-medium text-foreground">{key.provider}</span>
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                {key.configured ? key.keyMasked ?? "Configured" : "Not configured"}
                              </p>
                            </div>
                          </div>
                          <button onClick={() => { setEditingKey(editingKey === key.id ? null : key.id); setKeyInput(""); }}
                            className="text-xs text-primary hover:text-primary/80 transition-colors">
                            {key.configured ? "Update" : "Add Key"}
                          </button>
                        </div>
                        {editingKey === key.id && (
                          <div className="mt-2 flex gap-2">
                            <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)}
                              placeholder={`Enter ${key.provider} API key...`}
                              onKeyDown={(e) => e.key === "Enter" && handleSaveKey(key.id)}
                              className="flex-1 glass rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none" autoFocus />
                            <button onClick={() => handleSaveKey(key.id)}
                              className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90">
                              Save
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                    {apiKeys.length === 0 && (
                      <p className="text-xs text-muted-foreground">Configure model providers in the Admin console.</p>
                    )}
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
