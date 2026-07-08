"""
OakTable — FastAPI application entry point.

Signaling flow:
  The signaling router is included below. All WebRTC signaling
  (SDP offers/answers and ICE candidates) is relayed through the
  WebSocket endpoint defined in signaling.py.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from signaling import router as signaling_router

app = FastAPI(title="OakTable Signaling Server", version="0.1.0")

# Allow all origins for now (restrict in production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include signaling WebSocket router
app.include_router(signaling_router)


@app.get("/health")
async def health_check() -> dict:
    """Simple health-check endpoint."""
    return {"status": "ok"}