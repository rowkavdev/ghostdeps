import axios from "axios";

export const status = async (): Promise<number> => (await axios.get("/health")).status;
