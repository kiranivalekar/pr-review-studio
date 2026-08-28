import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.errors import AppError
from app.routes.prs import router as prs_router
from app.routes.reviews import router as reviews_router

logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(prs_router, prefix="/api")
app.include_router(reviews_router, prefix="/api")


@app.exception_handler(AppError)
async def handle_app_error(_request: Request, err: AppError) -> JSONResponse:
    logger.error(err)
    return JSONResponse(status_code=err.status, content={"error": err.message})


@app.exception_handler(Exception)
async def handle_unexpected_error(_request: Request, err: Exception) -> JSONResponse:
    logger.exception(err)
    return JSONResponse(status_code=500, content={"error": str(err) or "Internal error"})
