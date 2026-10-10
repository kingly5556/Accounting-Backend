import { Router } from "express";
import { asyncHandler } from "../../shared/middleware/error-handler.js";
import { requireServiceKey } from "../auth/service-key.middleware.js";
import { postingRequestSchema } from "./posting-rules.js";
import { postEvent } from "./postings.service.js";

// Service-to-service only (Stock's outbox worker). No user JWT, no roles: the
// X-Service-Key header is the sole credential and no other route accepts it.
export const postingsRouter = Router();
postingsRouter.use(requireServiceKey);

// 201 = booked now, 200 = this event was already booked (idempotent replay).
// Any 4xx is permanent for the sender: it must not retry the same payload.
postingsRouter.post("/", asyncHandler(async (req, res) => {
  const request = postingRequestSchema.parse(req.body);
  const result = await postEvent(request);
  res.status(result.created ? 201 : 200).json(result);
}));
