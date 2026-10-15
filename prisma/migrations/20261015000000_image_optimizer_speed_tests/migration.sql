-- AlterTable
ALTER TABLE "ImageBackup" DROP COLUMN "alt",
DROP COLUMN "newMediaId",
DROP COLUMN "originalUrl",
DROP COLUMN "position",
ADD COLUMN     "backupFileId" TEXT,
ADD COLUMN     "backupUrl" TEXT,
ADD COLUMN     "filename" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "SpeedTest" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "score" INTEGER,
    "lcpMs" INTEGER,
    "cls" DOUBLE PRECISION,
    "tbtMs" INTEGER,
    "fcpMs" INTEGER,
    "siMs" INTEGER,
    "field" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpeedTest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpeedTest_shopId_page_strategy_createdAt_idx" ON "SpeedTest"("shopId", "page", "strategy", "createdAt");

-- CreateIndex
CREATE INDEX "ImageBackup_shopId_mediaId_createdAt_idx" ON "ImageBackup"("shopId", "mediaId", "createdAt");

-- AddForeignKey
ALTER TABLE "SpeedTest" ADD CONSTRAINT "SpeedTest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

