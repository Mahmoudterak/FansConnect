import { Router, type IRouter } from "express";

const router: IRouter = Router();

const plans = [
  {
    code: "starter",
    name: "Starter",
    currency: "AED",
    billingInterval: "MONTHLY",
    amount: 149,
    description: "For a focused inbox",
    limits: { channels: 1, conversations: 500, teamMembers: 2 },
    features: ["1 channel", "500 conversations", "Core assistant"],
  },
  {
    code: "growth",
    name: "Growth",
    currency: "AED",
    billingInterval: "MONTHLY",
    amount: 349,
    description: "For teams that move fast",
    limits: { channels: 2, conversations: 2500, teamMembers: 8 },
    features: ["WhatsApp + Instagram", "2,500 conversations", "Flows and analytics"],
  },
  {
    code: "scale",
    name: "Scale",
    currency: "AED",
    billingInterval: "MONTHLY",
    amount: 699,
    description: "For growing operations",
    limits: { channels: 2, conversations: -1, teamMembers: -1 },
    features: ["Everything in Growth", "Unlimited team members", "Priority support"],
  },
] as const;

router.get("/plans", (_req, res) => {
  res.json({ currency: "AED", billingInterval: "MONTHLY", plans });
});

export default router;