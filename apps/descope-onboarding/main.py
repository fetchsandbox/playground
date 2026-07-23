"""Acme Notes — API with Descope OTP auth."""

from __future__ import annotations

import os

from descope import DescopeClient
from descope.exceptions import AuthException
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Acme Notes")

DESCOPE_PROJECT_ID = os.environ.get("DESCOPE_PROJECT_ID", "")
descope_client = DescopeClient(project_id=DESCOPE_PROJECT_ID)

_NOTES: dict[str, list[str]] = {}


class SignupReq(BaseModel):
    email: str


class VerifyReq(BaseModel):
    email: str
    code: str


class Note(BaseModel):
    text: str


@app.post("/signup")
def signup(body: SignupReq) -> dict:
    """Send a Descope OTP sign-up code to the given email."""
    descope_client.otp.sign_up(method="email", login_id=body.email)
    _NOTES.setdefault(body.email, [])
    return {"ok": True, "message": f"OTP sent to {body.email}"}


@app.post("/verify")
def verify(body: VerifyReq) -> dict:
    """Verify OTP code and return a real Descope session."""
    resp = descope_client.otp.verify_code(method="email", login_id=body.email, code=body.code)
    return {
        "ok": True,
        "user": body.email,
        "sessionJwt": resp["sessionJwt"],
        "refreshJwt": resp["refreshJwt"],
    }


def _current_user(authorization: str) -> str:
    token = authorization.replace("Bearer ", "", 1)
    if not token:
        raise HTTPException(401, "no session")
    try:
        claims = descope_client.validate_session(token)
        return claims["sub"]
    except AuthException:
        raise HTTPException(401, "invalid session")


@app.get("/notes")
def list_notes(authorization: str = Header(default="")) -> dict:
    user = _current_user(authorization)
    return {"notes": _NOTES.get(user, [])}


@app.post("/notes")
def add_note(note: Note, authorization: str = Header(default="")) -> dict:
    user = _current_user(authorization)
    _NOTES.setdefault(user, []).append(note.text)
    return {"ok": True, "count": len(_NOTES[user])}