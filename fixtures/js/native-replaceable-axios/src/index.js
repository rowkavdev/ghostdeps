import axios from "axios";

// Only simple GET/JSON usage: replaceable by native fetch on Node 18+.
export async function loadUser(id) {
  const response = await axios.get(`https://api.example.com/users/${id}`);
  return response.data;
}
