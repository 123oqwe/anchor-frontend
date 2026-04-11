import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { Anchor, ArrowLeft } from "lucide-react";

export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen flex items-center justify-center dot-grid">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="text-center"
      >
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 rounded-2xl glass flex items-center justify-center">
            <Anchor className="h-8 w-8 text-primary" />
          </div>
        </div>
        <h1 className="text-6xl font-bold text-foreground mb-2 font-mono">404</h1>
        <p className="text-muted-foreground mb-8">This page doesn't exist in your graph.</p>
        <button
          onClick={() => setLocation("/")}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </button>
      </motion.div>
    </div>
  );
}
