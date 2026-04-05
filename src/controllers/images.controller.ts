import { Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";

const UPLOADS_FOLDER = path.join(__dirname, "../files");
if (!fs.existsSync(UPLOADS_FOLDER)) {
    fs.mkdirSync(UPLOADS_FOLDER, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_FOLDER);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, uniqueName);
    },
});

const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const allowedTypes = ["image/jpeg", "image/png", "application/pdf"];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error("Apenas arquivos JPG, PNG ou PDF são permitidos"));
    }
};

const upload = multer({ storage, fileFilter });

export const uploadFiles = upload.fields([
    { name: "image", maxCount: 1 },
]);

export const sendFiles = async (req: Request, res: Response) => {
    try {
        const image = (req.files as { [fieldname: string]: Express.Multer.File[] })["image"][0].filename;
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const path = `${baseUrl}/api/images/files/${image}`;

        return res.status(200).json({
            status: true,
            path,
        });
    } catch (error) {
        console.error("Error uploading image:", error);
        return res.status(500).json({ status: false, msg: "Internal Server Error" });
    }
};

