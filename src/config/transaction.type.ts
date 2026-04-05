import mongoose from "mongoose";

export interface TransactionPixResponse {
    transactionId: string;
    status: "pending" | "completed" | "failed",
    amount: number;
    pix: string;
}
export interface TransactionCardResponse {
    transactionId: string;
    status: "pending" | "completed" | "failed",
    amount: number;
}


export interface TransactionPayload {
    userId: mongoose.Types.ObjectId;
    value: number;
    paymentMethod: "pix" | "card" | "boleto";
    card?: {
        number: string;
        holderName: string;
        expirationMonth: number;
        expirationYear: number;
        cvv: string;
    };
    customer: {
        name: string;
        email: string;
        phone: string;
        document: {
            number: string;
            type: "CPF" | "CNPJ"
        }
    };
    installments: number;
    installmentFee: number;
    ip: string;
    postback: string;
    products?: {
        name: string;
        price: number;
    }[];
    trackingParameters?: {
        utm_source: string | null;
        utm_medium: string | null;
        utm_campaign: string | null;
        utm_term: string | null;
        utm_content: string | null;
    }
}
