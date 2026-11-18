// BENCHMARK: safe - context-appropriate HTML escaping
import jakarta.servlet.http.*;
import org.springframework.web.util.HtmlUtils;

public class SafeSearchServlet extends HttpServlet {
    protected void doGet(HttpServletRequest request, HttpServletResponse response)
            throws Exception {
        String query = request.getParameter("q");
        String escaped = HtmlUtils.htmlEscape(query);
        response.getWriter().write("Results for " + escaped);
    }
}
